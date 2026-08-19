-- Make scoring, door rewards, and answer submission survive a host reopening a
-- question. Consolidated-plan finding C4 / migrations review finding F5.
--
-- `phase` is host-mutable (set_live_room_state accepts any enum value in any
-- order), and three irreversible operations were using it as their only
-- idempotency key:
--
--   1. lock_and_score_live_question inserted fresh score_events on every run and
--      never removed prior ones, so re-locking a scored question double-awarded
--      every correct player.
--   2. reveal_live_door_rewards re-rolled resolved_multiplier for every choice in
--      the round whenever it was entered at phase = 'door_choice', so a host who
--      set the phase back re-randomized rewards players had already seen —
--      contradicting PRODUCT_SPEC's promise that randomized outcomes are
--      persisted so refreshes cannot reroll them.
--   3. submit_live_answer never consulted submissions.is_locked, so a reopened
--      question accepted edits to already-locked rows.
--
-- The lock function below is 0034's (categorize partial credit included, which
-- is what production runs) plus the delete. It is deliberately NOT based on
-- 0030: rebuilding it from 0030 would silently revert partial credit.
--
-- A partial unique index on (session_id, player_id, question_id) where
-- created_by = 'system' was considered and rejected: it fails to create if any
-- existing session already carries duplicate system events from a past re-lock,
-- which would make this migration unrunnable against the live database, and it
-- would turn a re-lock into a mid-show duplicate-key exception instead of an
-- idempotent re-score.
--
-- Client follow-up, NOT done here: submit_live_answer's new rejection string
-- ('Your answer to this question is already locked') is not in room-api.js's
-- SUBMIT_ANSWER_CONFLICT_REASONS map, so it classifies as "unexpected" and the
-- player sees a save-failed state rather than the quiet abandoned state. That is
-- truthful and does not retry-loop, but whoever owns room-api.js should map it.
--
-- Data-compatibility: no schema change. No existing rows are rewritten by
-- applying this file; the delete only runs inside a future lock call. Prior
-- duplicate score events from past re-locks are NOT cleaned up here — the first
-- re-lock of a given question clears them, and anything older stays until then.

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
  delete from public.score_events where session_id = active_session.id and question_id = active_session.state ->> 'questionId' and created_by = 'system';
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

create or replace function public.reveal_live_door_rewards(
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
  bonus_definition jsonb;
  choice_row record;
  door_definition jsonb;
  outcome jsonb;
  outcome_position integer;
  selected_position integer;
  roll numeric;
  cumulative numeric;
  resolved numeric(6,2);
  public_results jsonb;
begin
  select * into active_session from public.sessions
  where room_code = upper(trim(p_room_code)) and host_secret_hash = public.token_hash(p_host_secret)
  for update;
  if not found then raise exception 'Host authorization failed'; end if;
  if active_session.phase::text not in ('door_choice', 'door_reveal') then raise exception 'Door rewards are not ready to reveal'; end if;

  if active_session.phase::text = 'door_choice' then
    select definition into quiz_definition from public.quiz_versions where id = active_session.quiz_version_id;
    bonus_definition := quiz_definition -> 'betweenRoundBonus';
    for choice_row in
      select * from public.session_door_choices
      where session_id = active_session.id and target_round_index = active_session.current_round_index
        -- Resolve each choice exactly once. `revealed_at` is set below and is
        -- cleared by choose_live_door when a player picks a different door, so
        -- a genuinely new or changed choice still rolls, while a host who sets
        -- the phase back to door_choice can no longer re-randomize a reward a
        -- player has already been shown.
        and revealed_at is null
      for update
    loop
      select door into door_definition
      from jsonb_array_elements(coalesce(bonus_definition -> 'doors', '[]'::jsonb)) door
      where door ->> 'id' = choice_row.door_id limit 1;
      if door_definition is null then continue; end if;
      roll := random() * 100; cumulative := 0; selected_position := 0; resolved := null; outcome_position := 0;
      for outcome in select value from jsonb_array_elements(coalesce(door_definition -> 'outcomes', '[]'::jsonb)) loop
        cumulative := cumulative + coalesce((outcome ->> 'chancePercent')::numeric, 0);
        if resolved is null and roll < cumulative then
          selected_position := outcome_position;
          resolved := (outcome ->> 'multiplier')::numeric;
        end if;
        outcome_position := outcome_position + 1;
      end loop;
      if resolved is null then
        selected_position := greatest(outcome_position - 1, 0);
        resolved := coalesce((door_definition -> 'outcomes' -> selected_position ->> 'multiplier')::numeric, 1);
      end if;
      update public.session_door_choices set outcome_index = selected_position, resolved_multiplier = resolved, revealed_at = now(), updated_at = now() where id = choice_row.id;
    end loop;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'playerId', p.id, 'playerName', p.display_name, 'logoKey', p.logo_key,
    'doorId', c.door_id, 'multiplier', c.resolved_multiplier
  ) order by p.display_name), '[]'::jsonb) into public_results
  from public.session_door_choices c
  join public.session_players p on p.id = c.player_id
  where c.session_id = active_session.id and c.target_round_index = active_session.current_round_index;

  update public.sessions set
    phase = 'door_reveal',
    state = state || jsonb_build_object('phase', 'door_reveal', 'doorResults', public_results),
    revision = case when phase::text = 'door_choice' then revision + 1 else revision end,
    updated_at = now()
  where id = active_session.id
  returning * into active_session;

  return jsonb_build_object('revision', active_session.revision, 'phase', active_session.phase, 'results', public_results);
end;
$$;

create or replace function public.submit_live_answer(
  p_room_code text,
  p_player_token text,
  p_question_id text,
  p_answer jsonb,
  p_server_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  active_player public.session_players;
  saved_submission public.submissions;
begin
  select s.* into active_session
  from public.sessions s
  join public.session_players p on p.session_id = s.id
  where s.room_code = upper(trim(p_room_code))
    and p.player_token_hash = public.token_hash(p_player_token)
  for update of s;
  if not found then raise exception 'Player is not in this room'; end if;
  select * into active_player
  from public.session_players
  where session_id = active_session.id
    and player_token_hash = public.token_hash(p_player_token);
  if active_session.phase <> 'question_open' then raise exception 'Answers are not open'; end if;
  if active_session.revision <> p_server_revision then raise exception 'This question has changed; refresh and try again'; end if;
  if active_session.state ->> 'questionId' <> p_question_id then raise exception 'That is not the active question'; end if;
  -- Phase alone is not enough: a reopened question is `question_open` again
  -- while the rows locked by the first lock_and_score_live_question pass are
  -- still flagged. An already-locked answer is final.
  if exists (
    select 1 from public.submissions
    where session_id = active_session.id and question_id = p_question_id
      and player_id = active_player.id and is_locked
  ) then raise exception 'Your answer to this question is already locked'; end if;

  insert into public.submissions (session_id, question_id, player_id, answer, server_revision)
  values (active_session.id, p_question_id, active_player.id, p_answer, active_session.revision)
  on conflict (session_id, question_id, player_id)
  do update set answer = excluded.answer, updated_at = now(), server_revision = excluded.server_revision
  returning * into saved_submission;

  return jsonb_build_object('submissionId', saved_submission.id, 'submittedAt', saved_submission.submitted_at);
end;
$$;

grant execute on function public.lock_and_score_live_question(text, text) to anon, authenticated;
grant execute on function public.reveal_live_door_rewards(text, text) to anon, authenticated;
grant execute on function public.submit_live_answer(text, text, text, jsonb, bigint) to anon, authenticated;
