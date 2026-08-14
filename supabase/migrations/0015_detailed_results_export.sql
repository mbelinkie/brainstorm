-- Host-only audit export for post-game review, including automatic scoring and
-- manual adjustments without exposing any player token or answer payload.

create or replace function public.get_host_score_events(
  p_room_code text,
  p_host_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare active_session public.sessions;
begin
  select * into active_session from public.sessions
  where room_code = upper(trim(p_room_code)) and host_secret_hash = public.token_hash(p_host_secret);
  if not found then raise exception 'Host authorization failed'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'displayName', p.display_name,
      'questionId', e.question_id,
      'points', e.points,
      'reason', e.reason,
      'createdAt', e.created_at
    ) order by e.created_at, p.display_name)
    from public.score_events e
    join public.session_players p on p.id = e.player_id
    where e.session_id = active_session.id
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.get_host_score_events(text, text) to anon, authenticated;
