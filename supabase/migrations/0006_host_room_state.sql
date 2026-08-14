-- Allows the authenticated host to restore the active room after a browser
-- refresh without exposing state to anyone who only knows the room code.

create or replace function public.get_host_live_room_state(
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

grant execute on function public.get_host_live_room_state(text, text) to anon, authenticated;
