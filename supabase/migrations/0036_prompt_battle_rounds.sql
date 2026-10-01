-- Prompt Battle slice 2: the four round phases, the pairing tables, and the
-- three host RPCs that open a round, choose the effective engine, and read the
-- pairing back.
--
-- Spec: docs/superpowers/specs/2026-08-17-prompt-battle-design.md sections 4,
-- 5, 6, 8 and 9, as amended by
-- docs/superpowers/specs/2026-08-24-prompt-battle-free-engine-addendum.md
-- section 5.
--
-- Deliberately NOT in this migration, because nothing writes them yet and an
-- unused table is a commitment:
--   * session_battle_generations (slice 3, image generation)
--   * session_battle_votes       (slice 5, voting)
--   * the media_assets.uploaded_by nullability change from base spec 8.1
--     (slice 3, when a generated image is first persisted)
--   * can_access_live_media's battle rules from base spec section 11
--     (slice 3, for the same reason)
--
-- The base spec numbers this migration 0033. That number was taken by
-- 0033_closest_number_player_names.sql before this slice was written, and
-- migrations here are append-only and contiguous (test/migration-hygiene.test.js
-- enforces both), so it lands at 0036 instead.

alter type public.session_phase add value if not exists 'battle_prompt';
alter type public.session_phase add value if not exists 'battle_review';
alter type public.session_phase add value if not exists 'battle_vote';
alter type public.session_phase add value if not exists 'battle_result';

-- The shuffle seed and the effective engine are session state, but they are
-- NOT public room state: sessions.state is returned verbatim to every player
-- phone by get_live_room_state(), so anything placed there is a player-visible
-- field by default. Dedicated columns keep both out of that payload without
-- depending on a future editor of publicRoomState() remembering to filter them.
--
-- battle_shuffle_seed is generated once per session and never rewritten. It is
-- what makes a pairing reproducible and auditable after the fact: given the
-- seed, the round index, and the player IDs, the ordering below can be
-- recomputed exactly.
alter table public.sessions
  add column if not exists battle_shuffle_seed bigint,
  add column if not exists battle_engine_provider text,
  add column if not exists battle_engine_model text;

create table if not exists public.session_battle_matchups (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  round_index integer not null check (round_index >= 0),
  matchup_index integer not null check (matchup_index >= 0),
  prompt_id text not null check (char_length(prompt_id) between 1 and 64),
  prompt_text text not null check (char_length(prompt_text) between 1 and 2048),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (session_id, round_index, matchup_index)
);

create table if not exists public.session_battle_entries (
  id uuid primary key default gen_random_uuid(),
  matchup_id uuid not null references public.session_battle_matchups(id) on delete cascade,
  player_id uuid not null references public.session_players(id) on delete cascade,
  attempts_used integer not null default 0 check (attempts_used >= 0),
  submitted_asset_id uuid references public.media_assets(id),
  submitted_at timestamptz,
  vetoed_at timestamptz,
  veto_reason text,
  created_at timestamptz not null default now(),
  unique (matchup_id, player_id)
);

-- The two unique constraints above already index
-- (session_id, round_index, matchup_index) and (matchup_id, player_id), which
-- covers every lookup here except one: player_id is the trailing column of its
-- unique constraint, so a per-player lookup needs its own index.
create index if not exists session_battle_entries_player_idx
  on public.session_battle_entries (player_id);

-- Same shape as session_door_choices in 0025: RLS on, no policies, and no
-- grants to the browser roles. Every read and write goes through a
-- security definer RPC that checks the host secret or the player token first.
alter table public.session_battle_matchups enable row level security;
alter table public.session_battle_entries enable row level security;

-- This project has no blanket service_role SELECT (see 0019, 0023, 0028,
-- 0033). The Worker's /battle/generate route in slice 3 reads both tables
-- directly to resolve a player's entry and its matchup prompt, and a
-- PostgREST read without this grant fails at request time with a permission
-- error that is invisible locally and visible to the room as an empty panel.
grant select on table public.session_battle_matchups to service_role;
grant select on table public.session_battle_entries to service_role;

-- Shared projection used by both open_battle_round() and
-- get_host_battle_state() so the host sees one shape whichever call produced
-- it. Invoker rights on purpose: it holds no authorization check of its own,
-- and execute is revoked from public so only the definer functions above it
-- (which run as the owner, after checking the host secret) can call it.
create or replace function public.host_battle_state_payload(
  p_session_id uuid,
  p_round_index integer
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'roundIndex', p_round_index,
    'opened', exists (
      select 1 from public.session_battle_matchups
      where session_id = p_session_id and round_index = p_round_index
    ),
    'matchups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'matchupId', m.id,
        'matchupIndex', m.matchup_index,
        'promptId', m.prompt_id,
        'promptText', m.prompt_text,
        'resolvedAt', m.resolved_at,
        'entrants', coalesce((
          select jsonb_agg(jsonb_build_object(
            'entryId', e.id,
            'playerId', p.id,
            'playerName', p.display_name,
            'logoKey', p.logo_key,
            'attemptsUsed', e.attempts_used,
            'submitted', e.submitted_at is not null,
            'vetoed', e.vetoed_at is not null
          ) order by p.display_name)
          from public.session_battle_entries e
          join public.session_players p on p.id = e.player_id
          where e.matchup_id = m.id
        ), '[]'::jsonb)
      ) order by m.matchup_index)
      from public.session_battle_matchups m
      where m.session_id = p_session_id and m.round_index = p_round_index
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.host_battle_state_payload(uuid, integer) from public;

-- Pairs the joined players for the session's current round, assigns each
-- matchup a prompt, and creates one entry row per player.
--
-- IDEMPOTENT BY DESIGN. A host refresh, a double-click, or a second tab must
-- never re-randomise matchups players have already started working on, so the
-- first thing this does after authorizing is look for an existing pairing on
-- (session_id, current_round_index) and return it untouched. That check comes
-- before the quiz-definition validation deliberately: once a round is paired,
-- the pairing is the answer regardless of what the definition says now.
--
-- Re-calling it also leaves `phase` alone. A host who has already advanced to
-- battle_review should not be dragged back to battle_prompt by a stray click.
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

-- Writes the effective engine for the session (base spec section 7.5). The
-- host picks from a menu and never types a model string.
--
-- Validation here is the quiz's half of "deployment allowlist ∩ round's
-- permittedModels": SQL cannot see BATTLE_MODEL_ALLOWLIST, which lives in
-- cloudflare-worker.js, and copying it into a migration would create the
-- second divergent copy mistakes.md #8 is about. The Worker keeps enforcing
-- its own allowlist against whatever it reads back from these columns, so the
-- intersection still holds end to end.
--
-- The model must be permitted by EVERY prompt_battle round in the quiz, not
-- just one: there is a single effective engine per session, so a model only
-- some rounds permit would be the wrong engine for the others. In the ordinary
-- one-battle-round quiz this is exactly "the round's permittedModels".
--
-- No revision bump: the engine is not broadcast, so no client needs to re-read.
create or replace function public.set_battle_engine(
  p_room_code text,
  p_host_secret text,
  p_provider text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  quiz_definition jsonb;
  battle_round_count integer;
  permitting_round_count integer;
  safe_provider text;
  safe_model text;
begin
  select * into active_session
  from public.sessions
  where room_code = upper(trim(p_room_code))
    and host_secret_hash = public.token_hash(p_host_secret)
  for update;
  if not found then raise exception 'Host authorization failed'; end if;

  safe_provider := trim(coalesce(p_provider, ''));
  safe_model := trim(coalesce(p_model, ''));
  if safe_provider = '' or safe_model = '' then
    raise exception 'A battle engine needs both a provider and a model';
  end if;

  select definition into quiz_definition
  from public.quiz_versions
  where id = active_session.quiz_version_id;

  select count(*) into battle_round_count
  from jsonb_array_elements(coalesce(quiz_definition -> 'rounds', '[]'::jsonb)) as round_item
  where round_item ->> 'type' = 'prompt_battle';
  if battle_round_count = 0 then
    raise exception 'This quiz has no prompt battle round';
  end if;

  select count(*) into permitting_round_count
  from jsonb_array_elements(coalesce(quiz_definition -> 'rounds', '[]'::jsonb)) as round_item
  where round_item ->> 'type' = 'prompt_battle'
    and coalesce(round_item -> 'engine' -> 'permittedModels', '[]'::jsonb) @> to_jsonb(safe_model);
  if permitting_round_count < battle_round_count then
    raise exception 'That model is not permitted by this quiz';
  end if;

  update public.sessions set
    battle_engine_provider = safe_provider,
    battle_engine_model = safe_model,
    updated_at = now()
  where id = active_session.id
  returning * into active_session;

  return jsonb_build_object(
    'roomCode', active_session.room_code,
    'provider', active_session.battle_engine_provider,
    'model', active_session.battle_engine_model
  );
end;
$$;

-- Host-only read of the pairing. Every field here is host-and-Presentation
-- data: player names against matchups is precisely the mapping a player must
-- not hold during battle_prompt.
create or replace function public.get_host_battle_state(
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
begin
  select * into active_session
  from public.sessions
  where room_code = upper(trim(p_room_code))
    and host_secret_hash = public.token_hash(p_host_secret);
  if not found then raise exception 'Host authorization failed'; end if;

  return public.host_battle_state_payload(active_session.id, active_session.current_round_index)
    || jsonb_build_object(
      'roomCode', active_session.room_code,
      'revision', active_session.revision,
      'phase', active_session.phase,
      'shuffleSeed', active_session.battle_shuffle_seed,
      'engine', jsonb_build_object(
        'provider', active_session.battle_engine_provider,
        'model', active_session.battle_engine_model
      )
    );
end;
$$;

grant execute on function public.open_battle_round(text, text) to anon, authenticated;
grant execute on function public.set_battle_engine(text, text, text, text) to anon, authenticated;
grant execute on function public.get_host_battle_state(text, text) to anon, authenticated;
