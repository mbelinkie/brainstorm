-- 0041_prompt_battle_votes.sql
-- Prompt Battle slice 5b (issue #29): the private per-matchup vote, the host
-- vote counts, and the player media rule for the battle_vote and
-- battle_result phases.
--
-- Spec: docs/superpowers/specs/2026-08-17-prompt-battle-design.md section 9 as
-- amended by the 2026-08-24 free-engine addendum, and
-- docs/superpowers/specs/2026-08-26-prompt-battle-architecture.md.
--
-- Additive. One new private table, one new player RPC, and two replacements:
-- the shared host projection (a superset of its 0040 shape) and the private
-- media check (its 0037 player rules plus the vote/result rule). No column,
-- policy, enum, bucket or browser table grant is created or changed.
--
-- A vote reaches a matchup only through the session's existing numeric
-- battleMatchupIndex pointer, which the host already writes with the
-- authenticated set_live_room_state RPC from 0002. The vote RPC locks the
-- sessions row before it reads anything else, so a host advancing the pointer
-- and a player casting a vote serialize on that row: whoever commits second
-- observes the state the first one produced and acts on it.

create table if not exists public.session_battle_votes (
  id uuid primary key default gen_random_uuid(),
  matchup_id uuid not null references public.session_battle_matchups(id) on delete cascade,
  voter_player_id uuid not null references public.session_players(id) on delete cascade,
  entry_id uuid not null references public.session_battle_entries(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (matchup_id, voter_player_id)
);

-- RLS on, no policies, no browser grant. Every read and write goes through a
-- security definer RPC. There is no vote upsert, update or delete path
-- anywhere: a vote is written once or the call is refused.
alter table public.session_battle_votes enable row level security;

revoke all on table public.session_battle_votes from public, anon, authenticated, service_role;
grant select on table public.session_battle_votes to service_role;

-- The private media check. Signature, defaults, host branch, authored-media
-- branch and the battle_prompt / battle_review player rule are the 0037
-- versions. Only the battle_vote / battle_result player rule is new: it serves
-- the submitted, current, unvetoed, unforfeited images of the matchup the
-- session pointer names, to any joined player, and nothing else. Own unused
-- variants, other matchups, other rounds, other sessions, vetoed, forfeited
-- and unsubmitted images stay denied, and a missing or malformed pointer fails
-- closed.
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
      if active_session.phase::text in ('battle_prompt', 'battle_review') then
        return coalesce(asset.generated_by_player_id = active_player.id and exists (select 1 from public.session_battle_generations g join public.session_battle_entries e on e.id = g.entry_id join public.session_battle_matchups m on m.id = e.matchup_id where e.player_id = active_player.id and m.session_id = active_session.id and p_asset_id = any(g.asset_ids)), false);
      end if;

      if active_session.phase::text in ('battle_vote', 'battle_result') then
        return exists (
          select 1
          from public.session_battle_entries e
          join public.session_battle_matchups m on m.id = e.matchup_id
          where m.session_id = active_session.id
            and m.round_index = active_session.current_round_index
            and active_session.state -> 'battleMatchupIndex' = to_jsonb(m.matchup_index)
            and e.submitted_asset_id = p_asset_id
            and e.vetoed_at is null
            and e.forfeited_at is null
            and asset.source = 'battle'
            and asset.generated_by_player_id = e.player_id
        );
      end if;

      return false;
    end if;

    return active_session.state @> jsonb_build_object('question', jsonb_build_object('options', jsonb_build_array(jsonb_build_object('imageAssetId', p_asset_id::text))));
  end if;

  return false;
end;
$$;

revoke all on function public.can_access_live_media(text, uuid, text, text) from public;
grant execute on function public.can_access_live_media(text, uuid, text, text) to anon, authenticated, service_role;

-- The shared host projection, extended with two read-only per-matchup counts.
-- Every 0040 key is still returned with the same meaning and the same shape, so
-- existing host callers and the veto/undo RPC keep working unchanged. No
-- individual vote, voter identity or target choice is exposed here, and nothing
-- is moved into sessions.state.
create or replace function public.host_battle_state_payload(
  p_session_id uuid,
  p_round_index integer
)
returns jsonb
language sql
stable
set search_path = public
as $$
  with session_spend as (
    select coalesce(sum(g.cost_usd), 0) as total_usd
    from public.session_battle_generations g
    join public.session_battle_entries e on e.id = g.entry_id
    join public.session_battle_matchups m on m.id = e.matchup_id
    where m.session_id = p_session_id
  )
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
        'votesCast', (
          select count(*) from public.session_battle_votes v
          where v.matchup_id = m.id
        ),
        'eligibleVoters', (
          select count(*) from public.session_players ep
          where ep.session_id = p_session_id
            and ep.left_at is null
            and not exists (select 1 from public.session_battle_entries ee
              where ee.matchup_id = m.id and ee.player_id = ep.id)
        ),
        'viableEntryIds', coalesce((
          select jsonb_agg(e2.id order by e2.id)
          from public.session_battle_entries e2
          where e2.matchup_id = m.id
            and e2.submitted_asset_id is not null
            and e2.forfeited_at is null
            and e2.vetoed_at is null
        ), '[]'::jsonb),
        'skipped', not exists (select 1 from public.session_battle_entries e3
          where e3.matchup_id = m.id
            and e3.vetoed_at is null
            and e3.forfeited_at is null),
        'entrants', coalesce((
          select jsonb_agg(jsonb_build_object(
            'entryId', e.id,
            'playerId', p.id,
            'playerName', p.display_name,
            'logoKey', p.logo_key,
            'attemptsUsed', e.attempts_used,
            'submitted', e.submitted_at is not null,
            'submittedAssetId', e.submitted_asset_id,
            'submittedAt', e.submitted_at,
            'forfeited', e.forfeited_at is not null,
            'forfeitedAt', e.forfeited_at,
            'vetoed', e.vetoed_at is not null,
            'vetoedAt', e.vetoed_at,
            'vetoReason', e.veto_reason,
            'viable', (
              e.submitted_asset_id is not null
              and e.forfeited_at is null
              and e.vetoed_at is null
            ),
            'generations', coalesce((
              select jsonb_agg(jsonb_build_object(
                'attemptIndex', g.attempt_index,
                'status', g.status,
                'playerPrompt', g.player_prompt,
                'assetIds', to_jsonb(g.asset_ids)
              ) order by g.attempt_index)
              from public.session_battle_generations g
              where g.entry_id = e.id
            ), '[]'::jsonb)
          ) order by p.display_name)
          from public.session_battle_entries e
          join public.session_players p on p.id = e.player_id
          where e.matchup_id = m.id
        ), '[]'::jsonb)
      ) order by m.matchup_index)
      from public.session_battle_matchups m
      where m.session_id = p_session_id and m.round_index = p_round_index
    ), '[]'::jsonb),
    'sessionSpendUsd', (select total_usd from session_spend),
    'maxSessionSpendUsd', (
      select (q.definition -> 'rounds' -> p_round_index -> 'engine' ->> 'maxSessionSpendUsd')::numeric
      from public.sessions s
      join public.quiz_versions q on q.id = s.quiz_version_id
      where s.id = p_session_id
    )
  );
$$;

revoke all on function public.host_battle_state_payload(uuid, integer) from public, anon, authenticated, service_role;

-- The player vote. One row per matchup and voter, written once. The session row
-- is locked before anything is read and the target entry row is locked after
-- the matchup is resolved, so this call serializes with the host pointer and
-- phase advance and with a second vote from the same player.
--
-- Refusals: bad or left credentials, a null id, a phase other than
-- battle_vote, a matchup that is not this session's current round at the
-- pointer's index, a matchup whose resolver already ran, a voter who is an
-- entrant of the current matchup, an entry outside that matchup, a target that
-- is unsubmitted, vetoed or forfeited, an image that is not a battle image made
-- by the entry's own player, and a repeated vote. Each one happens before any
-- write, so a refusal leaves revision, state, timestamps and rows untouched.
create or replace function public.cast_battle_vote(
  p_room_code text,
  p_player_token text,
  p_matchup_id uuid,
  p_entry_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  active_player public.session_players;
  target_matchup public.session_battle_matchups;
  target_entry public.session_battle_entries;
  target_asset public.media_assets;
  new_vote public.session_battle_votes;
begin
  select s.* into active_session
  from public.sessions s
  join public.session_players p on p.session_id = s.id
  where s.room_code = upper(trim(p_room_code))
    and p.player_token_hash = public.token_hash(p_player_token)
  for update of s;
  if not found then
    raise exception 'Player credentials are not valid for this room';
  end if;

  select * into active_player
  from public.session_players
  where session_id = active_session.id
    and player_token_hash = public.token_hash(p_player_token);
  if not found then
    raise exception 'Player credentials are not valid for this room';
  end if;
  if active_player.left_at is not null then
    raise exception 'You have left this room and cannot vote';
  end if;

  if p_matchup_id is null then
    raise exception 'A matchup must be selected before voting';
  end if;
  if p_entry_id is null then
    raise exception 'An entry must be selected before voting';
  end if;

  if not (active_session.phase::text = 'battle_vote') then
    raise exception 'Voting is not open: this round is not in the battle_vote phase';
  end if;

  select m.* into target_matchup
  from public.session_battle_matchups m
  where m.id = p_matchup_id
    and m.session_id = active_session.id
    and m.round_index = active_session.current_round_index
    and m.resolved_at is null
    and m.matchup_index >= 0
    and active_session.state -> 'battleMatchupIndex' = to_jsonb(m.matchup_index);
  if not found then
    raise exception 'That matchup is not the current matchup for this round';
  end if;

  if exists (
    select 1
    from public.session_battle_entries e
    where e.matchup_id = target_matchup.id
      and e.player_id = active_player.id
  ) then
    raise exception 'Entrants of the current matchup cannot vote in their own matchup';
  end if;

  select e.* into target_entry
  from public.session_battle_entries e
  where e.id = p_entry_id
    and e.matchup_id = target_matchup.id
  for update of e;
  if not found then
    raise exception 'That entry is not a valid choice in this matchup';
  end if;

  if target_entry.forfeited_at is not null then
    raise exception 'That entry forfeited and cannot be voted for';
  end if;
  if target_entry.vetoed_at is not null then
    raise exception 'That entry was vetoed and cannot be voted for';
  end if;
  if target_entry.submitted_asset_id is null then
    raise exception 'That entry has no submitted image to vote for';
  end if;

  select * into target_asset
  from public.media_assets
  where id = target_entry.submitted_asset_id;
  if not found then
    raise exception 'That entry image is not a valid battle asset for this matchup';
  end if;
  if target_asset.source <> 'battle'
     or target_asset.generated_by_player_id is distinct from target_entry.player_id then
    raise exception 'That entry image is not a valid battle asset for this matchup';
  end if;

  if exists (
    select 1
    from public.session_battle_votes v
    where v.matchup_id = target_matchup.id
      and v.voter_player_id = active_player.id
  ) then
    raise exception 'You have already voted in this matchup';
  end if;

  begin
    insert into public.session_battle_votes (matchup_id, voter_player_id, entry_id)
    values (target_matchup.id, active_player.id, target_entry.id)
    returning * into new_vote;
  exception when unique_violation then
    raise exception 'You have already voted in this matchup';
  end;

  update public.sessions
  set revision = revision + 1,
      updated_at = now()
  where id = active_session.id;

  return jsonb_build_object('voteId', new_vote.id, 'matchupId', p_matchup_id, 'votedAt', new_vote.created_at);
end;
$$;

revoke all on function public.cast_battle_vote(text, text, uuid, uuid) from public;
revoke all on function public.cast_battle_vote(text, text, uuid, uuid) from anon, authenticated, service_role;
grant execute on function public.cast_battle_vote(text, text, uuid, uuid) to anon, authenticated;
