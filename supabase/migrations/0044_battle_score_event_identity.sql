-- 0044_battle_score_event_identity.sql
-- Give Prompt Battle events a durable matchup identity. question_id remains the
-- readable CSV label, and authored ordinary question IDs are free text.
-- Re-score ordinary questions without deleting battle awards that share a label.

alter table public.score_events
  add column if not exists battle_matchup_id uuid;

comment on column public.score_events.battle_matchup_id is
  'Prompt Battle award identity; question_id is a readable label and may collide with authored question IDs.';

-- Backfill only events that match a resolved result snapshot (winner awards)
-- or its persisted ballots (voter awards). Never classify by question_id alone.
with battle_winners as (
  select
    m.id as matchup_id,
    m.session_id,
    format('battle-r%s-m%s', m.round_index + 1, m.matchup_index + 1) as question_id,
    m.result ->> 'outcome' as outcome,
    coalesce((m.result ->> 'votesCast')::integer, 0) as votes_cast,
    entry ->> 'playerId' as player_id,
    coalesce((entry ->> 'votes')::integer, 0) as entry_votes,
    (entry ->> 'points')::numeric as points,
    count(*) over (partition by m.id) as winner_count
  from public.session_battle_matchups m
  cross join lateral jsonb_array_elements(m.result -> 'entries') as result_entries(entry)
  where m.resolved_at is not null
    and m.result is not null
    and m.result ->> 'outcome' in ('winner', 'tie', 'default')
    and entry ->> 'winner' = 'true'
)
update public.score_events e
set battle_matchup_id = w.matchup_id
from battle_winners w
where e.session_id = w.session_id
  and e.question_id = w.question_id
  and e.player_id::text = w.player_id
  and e.points = w.points
  and e.reason = case
    when w.outcome = 'default' then 'Prompt battle win by default'
    when w.outcome = 'tie' then format('Prompt battle tie (%s ways)', w.winner_count)
    else 'Prompt battle win'
  end || case
    when w.outcome <> 'default' and w.votes_cast > 0 then format(' · %s of %s votes', w.entry_votes, w.votes_cast)
    else ''
  end
  and e.created_by = 'system'
  and e.battle_matchup_id is null;

update public.score_events e
set battle_matchup_id = m.id
from public.session_battle_matchups m
join public.session_battle_votes v on v.matchup_id = m.id
where m.resolved_at is not null
  and m.result is not null
  and m.result ->> 'outcome' <> 'skipped'
  and coalesce((m.result ->> 'voterPoints')::numeric, 0) > 0
  and e.session_id = m.session_id
  and e.question_id = format('battle-r%s-m%s', m.round_index + 1, m.matchup_index + 1)
  and e.player_id = v.voter_player_id
  and e.points = (m.result ->> 'voterPoints')::numeric
  and e.reason = 'Prompt battle vote'
  and e.created_by = 'system'
  and e.battle_matchup_id is null;

-- The old label-shaped key rejects legitimate ordinary events. Score events
-- already cascade with their session; no FK here changes that audit retention.
drop index if exists public.score_events_battle_once_idx;
create unique index if not exists score_events_battle_matchup_once_idx
  on public.score_events (session_id, battle_matchup_id, player_id)
  where created_by = 'system' and battle_matchup_id is not null;

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
    insert into public.score_events (session_id, battle_matchup_id, player_id, question_id, points, reason, created_by)
    values (active_session.id, target_matchup.id, entrant.player_id, battle_question_id, winner_points, winner_reason, 'system');
  end loop;

  if outcome <> 'skipped' and voter_points > 0 then
    for voter in
      select distinct v.voter_player_id
      from public.session_battle_votes v
      where v.matchup_id = target_matchup.id
      order by v.voter_player_id
    loop
      insert into public.score_events (session_id, battle_matchup_id, player_id, question_id, points, reason, created_by)
      values (active_session.id, target_matchup.id, voter.voter_player_id, battle_question_id, voter_points, 'Prompt battle vote', 'system');
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

-- Keep the latest scorer from 0035 (which includes 0034 partial credit), and
-- clear only ordinary system events when a question is re-scored.
create or replace function public.lock_and_score_live_question(p_room_code text, p_host_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  active_session public.sessions; quiz_definition jsonb; active_question jsonb;
  answer_row record; awarded_points numeric(7,2); base_awarded_points numeric(7,2); answer_text text;
  correct_pair_count integer; score_count integer := 0;
  target_number numeric; winning_distance numeric; winner_count integer := 0; shared_points numeric(7,2); score_reason text;
  active_multiplier numeric(6,2); replaced_event_count integer := 0;
begin
  select * into active_session from public.sessions where room_code = upper(trim(p_room_code)) and host_secret_hash = public.token_hash(p_host_secret) for update;
  if not found then raise exception 'Host authorization failed'; end if;
  if active_session.phase <> 'question_open' then raise exception 'The active question is not open'; end if;
  select definition into quiz_definition from public.quiz_versions where id = active_session.quiz_version_id;
  select question_item into active_question from jsonb_array_elements(quiz_definition -> 'rounds') as round_item cross join lateral jsonb_array_elements(round_item -> 'questions') as question_item where question_item ->> 'id' = active_session.state ->> 'questionId' limit 1;
  if active_question is null then raise exception 'Active question is missing from this quiz version'; end if;
  update public.submissions set is_locked = true, updated_at = now() where session_id = active_session.id and question_id = active_session.state ->> 'questionId';

  -- Scoring this question again replaces its automatic verdict rather than
  -- adding to it. Without this, the two client paths that can reopen a scored
  -- question (the host "Testing shortcut" jump control, and the documented
  -- set_live_room_state reopen override) leave every correct player holding
  -- both awards. Only `system` events are cleared: manual host adjustments
  -- (adjust_live_score writes `host`) survive a re-lock untouched, as do the
  -- system events of every other question in the session.
  delete from public.score_events where session_id = active_session.id and question_id = active_session.state ->> 'questionId' and created_by = 'system' and battle_matchup_id is null;
  get diagnostics replaced_event_count = row_count;

  if active_question ->> 'type' = 'closest_number' and coalesce(active_question ->> 'targetNumber', '') ~ '^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)$' then
    target_number := (active_question ->> 'targetNumber')::numeric;
    select min(abs((answer #>> '{}')::numeric - target_number)) into winning_distance from public.submissions where session_id = active_session.id and question_id = active_session.state ->> 'questionId' and answer #>> '{}' ~ '^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)$';
    if winning_distance is not null then
      select count(*) into winner_count from public.submissions where session_id = active_session.id and question_id = active_session.state ->> 'questionId' and answer #>> '{}' ~ '^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)$' and abs((answer #>> '{}')::numeric - target_number) = winning_distance;
      shared_points := round(coalesce((active_question ->> 'points')::numeric, 1) / winner_count, 2);
    end if;
  end if;

  for answer_row in select * from public.submissions where session_id = active_session.id and question_id = active_session.state ->> 'questionId' loop
    awarded_points := 0; answer_text := answer_row.answer #>> '{}'; score_reason := 'Automatic scoring';
    if active_question ->> 'type' in ('single_choice', 'true_false', 'image_selection') then
      if coalesce(active_question -> 'correctOptionIds', '[]'::jsonb) @> jsonb_build_array(answer_text) then awarded_points := coalesce((active_question ->> 'points')::numeric, 1); end if;
    elsif active_question ->> 'type' = 'multiple_choice' then
      if (select array_agg(value order by value) from jsonb_array_elements_text(coalesce(answer_row.answer, '[]'::jsonb)) as value) = (select array_agg(value order by value) from jsonb_array_elements_text(coalesce(active_question -> 'correctOptionIds', '[]'::jsonb)) as value) then awarded_points := coalesce((active_question -> 'scoring' ->> 'points')::numeric, (active_question ->> 'points')::numeric, 1); end if;
    elsif active_question ->> 'type' = 'matching' then
      select count(*) into correct_pair_count from jsonb_each_text(coalesce(active_question -> 'correctPairs', '{}'::jsonb)) expected_pair where answer_row.answer ->> expected_pair.key = expected_pair.value;
      awarded_points := correct_pair_count * coalesce((active_question ->> 'pointsPerPair')::numeric, 1);
    elsif active_question ->> 'type' = 'multi_fill_in_the_blank' then
      select count(*) into correct_pair_count
      from jsonb_array_elements(coalesce(active_question -> 'clips', '[]'::jsonb)) clip
      where exists (
        select 1 from jsonb_array_elements_text(coalesce(clip -> 'acceptedAnswers', '[]'::jsonb)) expected_answer
        where regexp_replace(lower(expected_answer), '[^a-z0-9]+', '', 'g') = regexp_replace(lower(coalesce(answer_row.answer ->> (clip ->> 'id'), '')), '[^a-z0-9]+', '', 'g')
      );
      awarded_points := correct_pair_count * coalesce((active_question ->> 'pointsPerBlank')::numeric, 1);
    elsif active_question ->> 'type' in ('short_answer', 'fill_in_the_blank') then
      if exists (select 1 from jsonb_array_elements_text(case when active_question ? 'acceptedAnswers' then active_question -> 'acceptedAnswers' else coalesce(active_question -> 'blanks' -> 0 -> 'acceptedAnswers', '[]'::jsonb) end) as expected_answer where regexp_replace(lower(expected_answer), '[^a-z0-9]+', '', 'g') = regexp_replace(lower(coalesce(answer_text, '')), '[^a-z0-9]+', '', 'g')) then awarded_points := coalesce((active_question ->> 'points')::numeric, 1); end if;
    elsif active_question ->> 'type' = 'arrange_in_order' then
      select count(*) into correct_pair_count from jsonb_array_elements_text(coalesce(active_question -> 'correctOrder', '[]'::jsonb)) with ordinality expected_item(item_id, position) where answer_row.answer ->> expected_item.item_id = expected_item.position::text;
      if correct_pair_count = jsonb_array_length(coalesce(active_question -> 'correctOrder', '[]'::jsonb)) then awarded_points := coalesce((active_question -> 'scoring' ->> 'points')::numeric, (active_question ->> 'points')::numeric, 1); end if;
    elsif active_question ->> 'type' = 'categorize' then
      select count(*) into correct_pair_count from jsonb_each_text(coalesce(active_question -> 'correctCategories', '{}'::jsonb)) expected_category where answer_row.answer ->> expected_category.key = expected_category.value;
      if coalesce(active_question -> 'scoring' ->> 'pointsPerCorrectItem', active_question ->> 'pointsPerCorrectItem') is not null then
        awarded_points := correct_pair_count * coalesce((active_question -> 'scoring' ->> 'pointsPerCorrectItem')::numeric, (active_question ->> 'pointsPerCorrectItem')::numeric);
      elsif correct_pair_count = jsonb_object_length(coalesce(active_question -> 'correctCategories', '{}'::jsonb)) then
        awarded_points := coalesce((active_question -> 'scoring' ->> 'points')::numeric, (active_question ->> 'points')::numeric, 1);
      end if;
    elsif active_question ->> 'type' = 'closest_number' then
      if shared_points is not null and answer_text ~ '^[+-]?([0-9]+([.][0-9]+)?|[.][0-9]+)$' and abs(answer_text::numeric - target_number) = winning_distance then awarded_points := shared_points; score_reason := case when winner_count = 1 then 'Closest number' else format('Closest number (tied %s ways)', winner_count) end; end if;
    end if;
    if awarded_points > 0 then
      base_awarded_points := awarded_points;
      select coalesce(c.resolved_multiplier, 1) into active_multiplier from public.session_door_choices c where c.session_id = active_session.id and c.player_id = answer_row.player_id and c.target_round_index = active_session.current_round_index;
      active_multiplier := coalesce(active_multiplier, 1);
      awarded_points := round(base_awarded_points * active_multiplier, 2);
      if active_multiplier <> 1 then score_reason := format('%s · %sx door bonus', score_reason, active_multiplier); end if;
      insert into public.score_events (session_id, player_id, question_id, points, reason, created_by, base_points, multiplier) values (active_session.id, answer_row.player_id, active_session.state ->> 'questionId', awarded_points, score_reason, 'system', base_awarded_points, active_multiplier);
      score_count := score_count + 1;
    end if;
  end loop;
  update public.sessions set phase = 'question_locked', revision = revision + 1, updated_at = now() where id = active_session.id returning * into active_session;
  return jsonb_build_object('roomCode', active_session.room_code, 'revision', active_session.revision, 'phase', active_session.phase, 'scoredResponses', score_count, 'replacedEvents', replaced_event_count);
end;
$$;
