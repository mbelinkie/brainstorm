-- 0040_prompt_battle_review.sql
-- Prompt Battle slice 5a (issue #25): the host veto/undo RPC for one battle
-- entry plus the additive replacement of the shared host review projection.
--
-- Additive only. No table, column, policy, type, enum or direct table grant
-- is created here, and no scoring or voting path is touched. The review
-- helper below is a superset of its 0039 version: every key it returned is
-- still returned with the same meaning, including sessionSpendUsd and a zero
-- or null maxSessionSpendUsd, and each entrant and matchup gains derived,
-- read-only review fields.
--
-- Authorization follows 0039. A browser holds a room code plus the host
-- secret, and the security definer RPC checks that secret itself. The session
-- row is locked before the entry row, so a host command serializes with a
-- phase advance exactly the way the submission and lock RPCs already
-- serialize on that row.

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
        'viableEntryIds', coalesce((
          select jsonb_agg(e2.id order by e2.id)
          from public.session_battle_entries e2
          where e2.matchup_id = m.id
            and e2.submitted_asset_id is not null
            and e2.forfeited_at is null
            and e2.vetoed_at is null
        ), '[]'::jsonb),
        'skipped', not exists (
          select 1
          from public.session_battle_entries e3
          where e3.matchup_id = m.id
            and e3.vetoed_at is null
            and e3.forfeited_at is null
        ),
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

-- Host moderation of a single current-round entry: veto it with a reason, or
-- undo that veto. Exactly one explicit boolean drives the action, so a null
-- boolean is rejected rather than treated as an undo, and the reason is only
-- meaningful when vetoing. Every check runs before any write, so an invalid
-- call leaves the session revision, the entry row and the generations alone.
--
-- Repeat of the same state is a no-op: an identical veto (same trimmed
-- reason) and an undo of an entry that is already un-vetoed both return the
-- shared host payload without touching revision, vetoed_at or updated_at.
-- A meaningful change writes the veto fields, bumps revision and stamps
-- updated_at. The entry's submitted asset, submitted_at, forfeited_at and
-- its generations are never touched here, and sessions.state is untouched.

create or replace function public.veto_battle_entry(
  p_room_code text,
  p_host_secret text,
  p_entry_id uuid,
  p_reason text,
  p_veto boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  active_entry public.session_battle_entries;
  safe_reason text;
begin
  select * into active_session
  from public.sessions
  where room_code = upper(trim(p_room_code))
    and host_secret_hash = public.token_hash(p_host_secret)
  for update;
  if not found then raise exception 'Host authorization failed'; end if;

  if not (active_session.phase::text = 'battle_review') then
    raise exception 'This round is not open for review';
  end if;

  if p_veto is null then
    raise exception 'A veto state is required';
  end if;

  if p_entry_id is null then
    raise exception 'No entry was selected';
  end if;

  if p_veto then
    safe_reason := trim(coalesce(p_reason, ''));
    if safe_reason = '' then
      raise exception 'A veto reason is required';
    end if;
    if char_length(safe_reason) > 500 then
      raise exception 'A veto reason is limited to 500 characters';
    end if;
  end if;

  select e.* into active_entry
  from public.session_battle_entries e
  join public.session_battle_matchups m on m.id = e.matchup_id
  where m.session_id = active_session.id
    and m.round_index = active_session.current_round_index
    and e.id = p_entry_id
  for update of e;
  if not found then raise exception 'That entry is not in this round'; end if;

  if p_veto then
    if active_entry.vetoed_at is not null and active_entry.veto_reason = safe_reason then
      return public.host_battle_state_payload(active_session.id, active_session.current_round_index)
        || jsonb_build_object(
          'roomCode', active_session.room_code,
          'revision', active_session.revision,
          'phase', active_session.phase
        );
    end if;

    update public.session_battle_entries set vetoed_at = now(), veto_reason = safe_reason
    where id = active_entry.id
    returning * into active_entry;
  else
    if active_entry.vetoed_at is null and active_entry.veto_reason is null then
      return public.host_battle_state_payload(active_session.id, active_session.current_round_index)
        || jsonb_build_object(
          'roomCode', active_session.room_code,
          'revision', active_session.revision,
          'phase', active_session.phase
        );
    end if;

    update public.session_battle_entries set vetoed_at = null, veto_reason = null
    where id = active_entry.id
    returning * into active_entry;
  end if;

  update public.sessions set
    revision = revision + 1,
    updated_at = now()
  where id = active_session.id
  returning * into active_session;

  return public.host_battle_state_payload(active_session.id, active_session.current_round_index)
    || jsonb_build_object(
      'roomCode', active_session.room_code,
      'revision', active_session.revision,
      'phase', active_session.phase
    );
end;
$$;

-- The browser RPC follows 0039's grant discipline: PUBLIC loses the default
-- EXECUTE first and only the two browser roles get it back. The review helper
-- holds no authorization of its own, so it stays revoked from every browser
-- and Worker role and is reachable only from the definer functions above it.
revoke all on function public.veto_battle_entry(text, text, uuid, text, boolean) from public;
grant execute on function public.veto_battle_entry(text, text, uuid, text, boolean) to anon, authenticated;
