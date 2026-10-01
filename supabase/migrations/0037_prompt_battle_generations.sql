-- 0037_prompt_battle_generations.sql
-- Persist anonymous-player generation audit rows and relax media ownership for battle assets.
--
-- Retaining the existing media_assets RLS policy Quiz authors can read media records
-- for battle-sourced rows is a conscious decision. The policy matches rows to
-- allowlisted quiz authors via is_quiz_author(), and the existing storage.objects
-- policy "Quiz authors can read media objects" plus the Worker /author-media route let those authors
-- retrieve the image/object bytes, not just metadata. Existing trusted-author
-- admin permissions are retained. No CREATE/DROP/ALTER POLICY is performed here;
-- restricting trusted authors from battle rows while preserving current author
-- media access requires a separate scope decision.

create table if not exists public.session_battle_generations (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.session_battle_entries(id) on delete cascade,
  attempt_index integer not null,
  player_prompt text not null,
  provider text not null,
  model text not null,
  asset_ids uuid[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'complete', 'failed', 'blocked')),
  block_reason text,
  cost_usd numeric(8,4),
  created_at timestamptz not null default now(),
  unique (entry_id, attempt_index)
);

alter table public.session_battle_generations enable row level security;

-- RLS is on with no policies and no grants to anon/authenticated. Only service_role
-- gets an explicit SELECT; writes are intentionally deferred to future slices.
grant select on table public.session_battle_generations to service_role;

-- media_assets: allow battle-sourced rows without an auth.users uploader.
alter table public.media_assets alter column uploaded_by drop not null;
alter table public.media_assets add column if not exists source text not null default 'author'
  check (source in ('author', 'battle'));
alter table public.media_assets add column if not exists generated_by_player_id uuid
  references public.session_players(id) on delete set null;
alter table public.media_assets add column if not exists expires_at timestamptz;
alter table public.media_assets add constraint media_assets_owner_present
  check (source = 'battle' or uploaded_by is not null);

-- The quiz-media bucket already contains all generated MIME types (image/webp,
-- image/jpeg, image/png, plus video/mp4 and audio formats) from migration 0032.
-- No bucket change is needed here.

create or replace function public.can_access_live_media(
  p_room_code text,
  p_asset_id uuid,
  p_host_secret text default null,
  p_player_token text default null
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  active_session public.sessions;
  active_player public.session_players;
  asset public.media_assets;
begin
  select * into active_session from public.sessions where room_code = upper(trim(p_room_code));
  if not found then return false; end if;
  select * into asset from public.media_assets where id = p_asset_id;
  if not found then return false; end if;

  if p_host_secret is not null and active_session.host_secret_hash = public.token_hash(p_host_secret) then
    if asset.source = 'battle' then
      return exists (select 1 from public.session_players p where p.id = asset.generated_by_player_id and p.session_id = active_session.id);
    end if;
    return exists (select 1 from public.quiz_versions q where q.id = active_session.quiz_version_id and position(p_asset_id::text in q.definition::text) > 0);
  end if;

  if p_player_token is not null then
    select * into active_player from public.session_players p where p.session_id = active_session.id and p.player_token_hash = public.token_hash(p_player_token);
    if not found then return false; end if;

    if asset.source = 'battle' then
      if active_session.phase::text not in ('battle_prompt', 'battle_review', 'battle_vote', 'battle_result') then
        return false;
      end if;
      return coalesce(asset.generated_by_player_id = active_player.id and exists (select 1 from public.session_battle_generations g join public.session_battle_entries e on e.id = g.entry_id join public.session_battle_matchups m on m.id = e.matchup_id where e.player_id = active_player.id and m.session_id = active_session.id and p_asset_id = any(g.asset_ids)), false);
    end if;

    return active_session.state @> jsonb_build_object('question', jsonb_build_object('options', jsonb_build_array(jsonb_build_object('imageAssetId', p_asset_id::text))));
  end if;

  return false;
end;
$$;

grant execute on function public.can_access_live_media(text, uuid, text, text) to anon, authenticated, service_role;

create or replace function public.open_battle_round(
  p_room_code text,
  p_host_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  quiz_definition jsonb;
  battle_round jsonb;
  round_prompts jsonb;
  prompt_count integer;
  player_count integer;
  matchup_count integer;
  shuffle_seed bigint;
  assigned_prompt jsonb;
  new_matchup_id uuid;
  matchup_ids uuid[] := '{}';
  player_row record;
  player_ordinal integer := 0;
  target_matchup integer;
begin
  select * into active_session
  from public.sessions
  where room_code = upper(trim(p_room_code))
    and host_secret_hash = public.token_hash(p_host_secret)
  for update;
  if not found then raise exception 'Host authorization failed'; end if;
  -- `::text`, following 0025's precedent: a value added to session_phase by
  -- this same migration cannot be compared as a bare enum literal in the
  -- transaction that adds it, and mixing the two styles in one file is how
  -- that bites later.
  if active_session.phase::text = 'complete' then raise exception 'This game has finished'; end if;

  -- The idempotency guard.
  if exists (
    select 1 from public.session_battle_matchups
    where session_id = active_session.id
      and round_index = active_session.current_round_index
  ) then
    return public.host_battle_state_payload(active_session.id, active_session.current_round_index)
      || jsonb_build_object(
        'roomCode', active_session.room_code,
        'revision', active_session.revision,
        'phase', active_session.phase,
        'shuffleSeed', active_session.battle_shuffle_seed,
        'created', false
      );
  end if;

  select definition into quiz_definition
  from public.quiz_versions
  where id = active_session.quiz_version_id;

  battle_round := quiz_definition -> 'rounds' -> active_session.current_round_index;
  if battle_round is null then
    raise exception 'This quiz has no round at index %', active_session.current_round_index;
  end if;
  -- Slice 2 has no phase machine that can navigate a question-less round, so
  -- the round index is taken from the session as the host left it rather than
  -- inferred. A quiz with a battle round the room is not currently on fails
  -- here with a message that says which round it is looking at.
  if battle_round ->> 'type' is distinct from 'prompt_battle' then
    raise exception 'Round % is not a prompt battle round', active_session.current_round_index + 1;
  end if;

  round_prompts := coalesce(battle_round -> 'prompts', '[]'::jsonb);
  prompt_count := jsonb_array_length(round_prompts);
  if prompt_count = 0 then raise exception 'This battle round has no prompts'; end if;

  select count(*) into player_count
  from public.session_players
  where session_id = active_session.id and left_at is null;
  if player_count < 2 then
    raise exception 'A battle round needs at least two joined players';
  end if;

  -- Two players per matchup, floor-divided. An odd count leaves one player
  -- over, and that player joins the FINAL matchup, making it a three-way
  -- rather than leaving anyone unpaired (base spec section 6 rule 2).
  matchup_count := player_count / 2;

  if active_session.battle_shuffle_seed is null then
    shuffle_seed := floor(random() * 9007199254740992)::bigint;
    update public.sessions set battle_shuffle_seed = shuffle_seed where id = active_session.id;
  else
    shuffle_seed := active_session.battle_shuffle_seed;
  end if;
  select jsonb_agg(prompt_item order by md5(shuffle_seed::text || ':' || active_session.current_round_index::text || ':prompt:' || (prompt_item ->> 'id')), prompt_ordinal)
  into round_prompts
  from jsonb_array_elements(round_prompts) with ordinality as prompts(prompt_item, prompt_ordinal);

  for matchup_position in 0 .. matchup_count - 1 loop
    -- Prompts cycle when there are more matchups than authored prompts.
    assigned_prompt := round_prompts -> (matchup_position % prompt_count);
    insert into public.session_battle_matchups (
      session_id, round_index, matchup_index, prompt_id, prompt_text
    ) values (
      active_session.id,
      active_session.current_round_index,
      matchup_position,
      assigned_prompt ->> 'id',
      assigned_prompt ->> 'text'
    )
    returning id into new_matchup_id;
    matchup_ids := matchup_ids || new_matchup_id;
  end loop;

  -- Seeded, reproducible shuffle. md5 over (seed, round index, player id)
  -- rather than random(): the ordering is a pure function of values that are
  -- all persisted, so the pairing can be recomputed and audited later, and a
  -- second round in the same session still shuffles differently.
  for player_row in
    select p.id
    from public.session_players p
    where p.session_id = active_session.id and p.left_at is null
    order by md5(shuffle_seed::text || ':' || active_session.current_round_index::text || ':' || p.id::text)
  loop
    -- least() is the three-way: the odd player out would index one past the
    -- last matchup, and is clamped back into it.
    target_matchup := least(player_ordinal / 2, matchup_count - 1);
    insert into public.session_battle_entries (matchup_id, player_id)
    values (matchup_ids[target_matchup + 1], player_row.id);
    player_ordinal := player_ordinal + 1;
  end loop;

  -- Public state carries the round position only. The pairing, the entrants,
  -- and the prompt texts stay out of it: sessions.state reaches every player
  -- phone, and another matchup's prompt is future state.
  update public.sessions set
    phase = 'battle_prompt',
    state = state || jsonb_build_object(
      'phase', 'battle_prompt',
      'battleRoundIndex', active_session.current_round_index,
      'battleMatchupIndex', 0,
      'battleMatchupCount', matchup_count
    ),
    revision = revision + 1,
    started_at = case when started_at is null then now() else started_at end,
    updated_at = now()
  where id = active_session.id
  returning * into active_session;

  return public.host_battle_state_payload(active_session.id, active_session.current_round_index)
    || jsonb_build_object(
      'roomCode', active_session.room_code,
      'revision', active_session.revision,
      'phase', active_session.phase,
      'shuffleSeed', active_session.battle_shuffle_seed,
      'created', true
    );
end;
$$;

grant execute on function public.open_battle_round(text, text) to anon, authenticated;
