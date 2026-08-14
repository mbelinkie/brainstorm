-- Host-only, auditable score corrections for edge cases that automatic scoring
-- cannot resolve during a live game.

create or replace function public.adjust_live_score(
  p_room_code text,
  p_host_secret text,
  p_player_id uuid,
  p_points numeric,
  p_reason text default 'Host manual adjustment'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  active_player public.session_players;
  adjustment_reason text;
begin
  if p_points = 0 or p_points < -1000 or p_points > 1000 then
    raise exception 'Manual adjustment must be between -1000 and 1000, excluding zero';
  end if;

  select * into active_session
  from public.sessions
  where room_code = upper(trim(p_room_code))
    and host_secret_hash = public.token_hash(p_host_secret)
  for update;
  if not found then raise exception 'Host authorization failed'; end if;

  select * into active_player
  from public.session_players
  where id = p_player_id and session_id = active_session.id;
  if not found then raise exception 'Player is not in this room'; end if;

  adjustment_reason := coalesce(nullif(trim(p_reason), ''), 'Host manual adjustment');
  insert into public.score_events (session_id, player_id, question_id, points, reason, created_by)
  values (active_session.id, active_player.id, coalesce(active_session.state ->> 'questionId', 'manual-adjustment'), p_points, adjustment_reason, 'host');

  return jsonb_build_object('playerId', active_player.id, 'points', p_points, 'reason', adjustment_reason);
end;
$$;

grant execute on function public.adjust_live_score(text, text, uuid, numeric, text) to anon, authenticated;
