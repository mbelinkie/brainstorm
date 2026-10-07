-- 0042_prompt_battle_resolution.sql
-- Prompt Battle slice 6 (issue #30): resolve the current matchup once, award
-- its points through score_events, and return a result that reveals creators.
--
-- Spec: docs/superpowers/specs/2026-08-17-prompt-battle-design.md section 10
-- (scoring) and section 14 (forfeit, all-vetoed), and
-- docs/superpowers/specs/2026-08-26-prompt-battle-architecture.md.
--
-- Additive. One nullable column, one partial unique index, one host RPC. No
-- existing function, policy, enum or browser table grant is created or
-- changed, and nothing is added to sessions.state beyond the phase name.
--
-- Rules, in the order the resolver applies them:
--   * An entry is viable when it has a submitted image and is neither vetoed
--     nor forfeited (the same definition 0041's host projection and vote RPC
--     use). Votes for a non-viable entry are reported but can never win.
--   * No viable entry: the matchup is skipped. Nobody scores, voters included.
--   * One viable entry: it wins by default, whatever the votes say.
--   * Two or more: the highest vote count wins winnerPoints, and EVERY entry
--     tied on that count receives the full winnerPoints. A matchup nobody
--     voted on (a two- or three-player room has no eligible voters) is
--     therefore a tie between all its viable entries.
--   * Unless skipped, every player with a vote in the matchup receives
--     voterPoints. A zero voterPoints writes no event, as elsewhere.
--
-- Multipliers. Battle events are written with base_points and multiplier
-- null, like manual adjustments. Nothing in this function reads
-- session_door_choices, so the door multiplier (0025) never applies, and
-- 0026's catch-up trigger returns early for a null base_points, so a late
-- joiner's boost does not apply to voterPoints either. The reason text and
-- question_id carry the explanation the score-events CSV shows instead.
--
-- Idempotency. The session row is locked first, as every battle RPC does, so
-- this serializes with cast_battle_vote() and with a second host tab. The
-- matchup row is then locked and resolved_at checked: a resolved matchup
-- returns its stored result and writes nothing. The stored result is a
-- snapshot, so a host who walks the phase back and vetoes afterwards cannot
-- change what was announced or awarded. The partial unique index below backs
-- this at the table: a second system battle event for the same player and
-- matchup is a duplicate key, not a silent double award.

alter table public.session_battle_matchups
  add column if not exists result jsonb;

-- Battle question IDs are generated here as battle-r<round>-m<matchup>
-- (1-based). Authored question IDs are free text, so the predicate is a full
-- match on that shape rather than a prefix. Nothing writes this shape before
-- this migration, so the index cannot fail to build on existing rows.
create unique index if not exists score_events_battle_once_idx
  on public.score_events (session_id, question_id, player_id)
  where created_by = 'system' and question_id ~ '^battle-r[0-9]+-m[0-9]+$';

create or replace function public.resolve_battle_matchup(
  p_room_code text,
  p_host_secret text,
  p_matchup_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  target_matchup public.session_battle_matchups;
  battle_round jsonb;
  winner_points numeric(7,2);
  voter_points numeric(7,2);
  viable_count integer;
  top_votes integer;
  winner_count integer;
  total_votes integer;
  voter_count integer;
  outcome text;
  battle_question_id text;
  winner_reason text;
  entrant record;
  voter record;
  resolved_time timestamptz := now();
  entry_results jsonb;
  matchup_result jsonb;
begin
  select * into active_session
  from public.sessions
  where room_code = upper(trim(p_room_code))
    and host_secret_hash = public.token_hash(p_host_secret)
  for update;
  if not found then raise exception 'Host authorization failed'; end if;

  if p_matchup_id is null then
    raise exception 'A matchup must be selected before resolving';
  end if;

  select m.* into target_matchup
  from public.session_battle_matchups m
  where m.id = p_matchup_id
    and m.session_id = active_session.id
    and m.round_index = active_session.current_round_index
  for update of m;
  if not found then
    raise exception 'That matchup is not the current matchup for this round';
  end if;

  -- The idempotency guard. A replay is a read: any phase, no pointer check,
  -- no write, and the snapshot taken at resolution.
  if target_matchup.resolved_at is not null then
    return coalesce(target_matchup.result, jsonb_build_object(
        'matchupId', target_matchup.id,
        'resolvedAt', target_matchup.resolved_at
      ))
      || jsonb_build_object(
        'roomCode', active_session.room_code,
        'revision', active_session.revision,
        'phase', active_session.phase,
        'created', false
      );
  end if;

  if not (active_session.phase::text = 'battle_vote') then
    raise exception 'Resolution is not open: this round is not in the battle_vote phase';
  end if;
  if active_session.state -> 'battleMatchupIndex' is distinct from to_jsonb(target_matchup.matchup_index) then
    raise exception 'That matchup is not the current matchup for this round';
  end if;

  select q.definition -> 'rounds' -> target_matchup.round_index into battle_round
  from public.quiz_versions q
  where q.id = active_session.quiz_version_id;
  if battle_round ->> 'type' is distinct from 'prompt_battle' then
    raise exception 'Round % is not a prompt battle round', target_matchup.round_index + 1;
  end if;
  if coalesce(battle_round -> 'scoring' ->> 'winnerPoints', '') !~ '^[0-9]+([.][0-9]+)?$'
     or coalesce(battle_round -> 'scoring' ->> 'voterPoints', '') !~ '^[0-9]+([.][0-9]+)?$' then
    raise exception 'This battle round has no valid scoring';
  end if;
  winner_points := (battle_round -> 'scoring' ->> 'winnerPoints')::numeric;
  voter_points := (battle_round -> 'scoring' ->> 'voterPoints')::numeric;
  if winner_points <= 0 then
    raise exception 'This battle round has no valid scoring';
  end if;

  create temporary table if not exists pg_temp.battle_tally (
    entry_id uuid primary key,
    player_id uuid not null,
    viable boolean not null,
    votes integer not null,
    winner boolean not null default false
  ) on commit drop;
  delete from pg_temp.battle_tally;

  insert into pg_temp.battle_tally (entry_id, player_id, viable, votes)
  select e.id,
         e.player_id,
         (e.submitted_asset_id is not null and e.vetoed_at is null and e.forfeited_at is null),
         (select count(*) from public.session_battle_votes v where v.entry_id = e.id)
  from public.session_battle_entries e
  where e.matchup_id = target_matchup.id;

  select count(*) filter (where viable), coalesce(max(votes) filter (where viable), 0)
  into viable_count, top_votes
  from pg_temp.battle_tally;

  select count(*), count(distinct voter_player_id)
  into total_votes, voter_count
  from public.session_battle_votes
  where matchup_id = target_matchup.id;

  if viable_count = 0 then
    outcome := 'skipped';
  elsif viable_count = 1 then
    outcome := 'default';
    update pg_temp.battle_tally set winner = true where viable;
  else
    update pg_temp.battle_tally set winner = true where viable and votes = top_votes;
    select count(*) into winner_count from pg_temp.battle_tally where winner;
    outcome := case when winner_count > 1 then 'tie' else 'winner' end;
  end if;
  select count(*) into winner_count from pg_temp.battle_tally where winner;

  battle_question_id := format('battle-r%s-m%s', target_matchup.round_index + 1, target_matchup.matchup_index + 1);

  for entrant in select * from pg_temp.battle_tally where winner order by entry_id loop
    winner_reason := case outcome
      when 'default' then 'Prompt battle win by default'
      when 'tie' then format('Prompt battle tie (%s ways)', winner_count)
      else 'Prompt battle win'
    end;
    if outcome <> 'default' and total_votes > 0 then
      winner_reason := winner_reason || format(' · %s of %s votes', entrant.votes, total_votes);
    end if;
    insert into public.score_events (session_id, player_id, question_id, points, reason, created_by)
    values (active_session.id, entrant.player_id, battle_question_id, winner_points, winner_reason, 'system');
  end loop;

  if outcome <> 'skipped' and voter_points > 0 then
    for voter in
      select distinct v.voter_player_id
      from public.session_battle_votes v
      where v.matchup_id = target_matchup.id
      order by v.voter_player_id
    loop
      insert into public.score_events (session_id, player_id, question_id, points, reason, created_by)
      values (active_session.id, voter.voter_player_id, battle_question_id, voter_points, 'Prompt battle vote', 'system');
    end loop;
  end if;

  -- Creators are revealed here, and only here: before resolution no player
  -- payload maps an entry to its player.
  select coalesce(jsonb_agg(jsonb_build_object(
      'entryId', t.entry_id,
      'playerId', t.player_id,
      'playerName', p.display_name,
      'logoKey', p.logo_key,
      'assetId', e.submitted_asset_id,
      'votes', t.votes,
      'viable', t.viable,
      'vetoed', e.vetoed_at is not null,
      'forfeited', e.forfeited_at is not null,
      'winner', t.winner,
      'points', case when t.winner then winner_points else 0 end
    ) order by t.votes desc, p.display_name, t.entry_id), '[]'::jsonb)
  into entry_results
  from pg_temp.battle_tally t
  join public.session_battle_entries e on e.id = t.entry_id
  join public.session_players p on p.id = t.player_id;

  matchup_result := jsonb_build_object(
    'matchupId', target_matchup.id,
    'roundIndex', target_matchup.round_index,
    'matchupIndex', target_matchup.matchup_index,
    'promptText', target_matchup.prompt_text,
    'resolvedAt', resolved_time,
    'outcome', outcome,
    'winnerPoints', winner_points,
    'voterPoints', case when outcome = 'skipped' then 0 else voter_points end,
    'votesCast', total_votes,
    'voterCount', voter_count,
    'entries', entry_results
  );

  update public.session_battle_matchups
  set resolved_at = resolved_time,
      result = matchup_result
  where id = target_matchup.id;

  update public.sessions set
    phase = 'battle_result',
    state = state || jsonb_build_object('phase', 'battle_result'),
    revision = revision + 1,
    updated_at = now()
  where id = active_session.id
  returning * into active_session;

  return matchup_result || jsonb_build_object(
    'roomCode', active_session.room_code,
    'revision', active_session.revision,
    'phase', active_session.phase,
    'created', true
  );
end;
$$;

revoke all on function public.resolve_battle_matchup(text, text, uuid) from public;
revoke all on function public.resolve_battle_matchup(text, text, uuid) from anon, authenticated, service_role;
grant execute on function public.resolve_battle_matchup(text, text, uuid) to anon, authenticated;
