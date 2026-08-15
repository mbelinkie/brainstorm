-- Score every audio-title blank independently while preserving all existing
-- scoring modes and between-round multipliers.
create or replace function public.lock_and_score_live_question(p_room_code text, p_host_secret text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  active_session public.sessions; quiz_definition jsonb; active_question jsonb;
  answer_row record; awarded_points numeric(7,2); base_awarded_points numeric(7,2); answer_text text;
  correct_pair_count integer; score_count integer := 0;
  target_number numeric; winning_distance numeric; winner_count integer := 0; shared_points numeric(7,2); score_reason text;
  active_multiplier numeric(6,2);
begin
  select * into active_session from public.sessions where room_code = upper(trim(p_room_code)) and host_secret_hash = public.token_hash(p_host_secret) for update;
  if not found then raise exception 'Host authorization failed'; end if;
  if active_session.phase <> 'question_open' then raise exception 'The active question is not open'; end if;
  select definition into quiz_definition from public.quiz_versions where id = active_session.quiz_version_id;
  select question_item into active_question from jsonb_array_elements(quiz_definition -> 'rounds') as round_item cross join lateral jsonb_array_elements(round_item -> 'questions') as question_item where question_item ->> 'id' = active_session.state ->> 'questionId' limit 1;
  if active_question is null then raise exception 'Active question is missing from this quiz version'; end if;
  update public.submissions set is_locked = true, updated_at = now() where session_id = active_session.id and question_id = active_session.state ->> 'questionId';

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
      if correct_pair_count = jsonb_object_length(coalesce(active_question -> 'correctCategories', '{}'::jsonb)) then awarded_points := coalesce((active_question -> 'scoring' ->> 'points')::numeric, (active_question ->> 'points')::numeric, 1); end if;
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
  return jsonb_build_object('roomCode', active_session.room_code, 'revision', active_session.revision, 'phase', active_session.phase, 'scoredResponses', score_count);
end;
$$;
