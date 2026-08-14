-- Hosted-room RPC boundary. Browser clients use the publishable key only;
-- these narrowly scoped functions enforce room, host, and player tokens.

create or replace function public.room_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
begin
  for i in 1..6 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
  end loop;
  return result;
end;
$$;

create or replace function public.token_hash(value text)
returns text
language sql
immutable
strict
as $$ select encode(extensions.digest(value, 'sha256'), 'hex') $$;

create or replace function public.create_live_room(
  p_quiz_version_id uuid,
  p_host_secret text,
  p_initial_state jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  generated_room_code text;
  created_session public.sessions;
begin
  if char_length(p_host_secret) < 24 then
    raise exception 'Host secret must be at least 24 characters';
  end if;

  if not exists (select 1 from public.quiz_versions where id = p_quiz_version_id) then
    raise exception 'Quiz version not found';
  end if;

  loop
    generated_room_code := public.room_code();
    begin
      insert into public.sessions (room_code, quiz_version_id, host_secret_hash, state)
      values (generated_room_code, p_quiz_version_id, public.token_hash(p_host_secret), coalesce(p_initial_state, '{}'::jsonb))
      returning * into created_session;
      exit;
    exception when unique_violation then
      -- An extremely unlikely room-code collision: generate another one.
    end;
  end loop;

  return jsonb_build_object(
    'roomCode', created_session.room_code,
    'revision', created_session.revision,
    'phase', created_session.phase,
    'state', created_session.state
  );
end;
$$;

create or replace function public.join_live_room(
  p_room_code text,
  p_display_name text,
  p_player_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  active_player public.session_players;
begin
  if char_length(p_player_token) < 24 then
    raise exception 'Player token must be at least 24 characters';
  end if;

  select * into active_session from public.sessions where room_code = upper(trim(p_room_code));
  if not found then raise exception 'Room not found'; end if;
  if active_session.phase = 'complete' then raise exception 'This game has finished'; end if;

  insert into public.session_players (session_id, player_token_hash, display_name)
  values (active_session.id, public.token_hash(p_player_token), trim(p_display_name))
  on conflict (session_id, player_token_hash)
  do update set last_seen_at = now()
  returning * into active_player;

  return jsonb_build_object(
    'playerId', active_player.id,
    'roomCode', active_session.room_code,
    'revision', active_session.revision,
    'phase', active_session.phase,
    'roundIndex', active_session.current_round_index,
    'questionIndex', active_session.current_question_index,
    'state', active_session.state
  );
end;
$$;

create or replace function public.get_live_room_state(
  p_room_code text,
  p_player_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
begin
  select s.* into active_session
  from public.sessions s
  join public.session_players p on p.session_id = s.id
  where s.room_code = upper(trim(p_room_code))
    and p.player_token_hash = public.token_hash(p_player_token);
  if not found then raise exception 'Player is not in this room'; end if;

  return jsonb_build_object(
    'roomCode', active_session.room_code,
    'revision', active_session.revision,
    'phase', active_session.phase,
    'roundIndex', active_session.current_round_index,
    'questionIndex', active_session.current_question_index,
    'state', active_session.state
  );
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

  insert into public.submissions (session_id, question_id, player_id, answer, server_revision)
  values (active_session.id, p_question_id, active_player.id, p_answer, active_session.revision)
  on conflict (session_id, question_id, player_id)
  do update set answer = excluded.answer, updated_at = now(), server_revision = excluded.server_revision
  returning * into saved_submission;

  return jsonb_build_object('submissionId', saved_submission.id, 'submittedAt', saved_submission.submitted_at);
end;
$$;

create or replace function public.set_live_room_state(
  p_room_code text,
  p_host_secret text,
  p_phase public.session_phase,
  p_round_index integer,
  p_question_index integer,
  p_public_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_session public.sessions;
begin
  update public.sessions
  set phase = p_phase,
      current_round_index = p_round_index,
      current_question_index = p_question_index,
      state = coalesce(p_public_state, '{}'::jsonb),
      revision = revision + 1,
      started_at = case when started_at is null and p_phase <> 'lobby' then now() else started_at end,
      completed_at = case when p_phase = 'complete' then now() else completed_at end,
      updated_at = now()
  where room_code = upper(trim(p_room_code))
    and host_secret_hash = public.token_hash(p_host_secret)
  returning * into updated_session;
  if not found then raise exception 'Host authorization failed'; end if;

  return jsonb_build_object(
    'roomCode', updated_session.room_code,
    'revision', updated_session.revision,
    'phase', updated_session.phase,
    'roundIndex', updated_session.current_round_index,
    'questionIndex', updated_session.current_question_index,
    'state', updated_session.state
  );
end;
$$;

revoke all on function public.room_code() from public;
revoke all on function public.token_hash(text) from public;
grant execute on function public.create_live_room(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.join_live_room(text, text, text) to anon, authenticated;
grant execute on function public.get_live_room_state(text, text) to anon, authenticated;
grant execute on function public.submit_live_answer(text, text, text, jsonb, bigint) to anon, authenticated;
grant execute on function public.set_live_room_state(text, text, public.session_phase, integer, integer, jsonb) to anon, authenticated;
