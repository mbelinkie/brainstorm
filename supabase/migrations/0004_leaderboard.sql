-- Public presentation data only: display names and accumulated points. A
-- caller must be either the authenticated room host or a joined player.

create or replace function public.get_live_leaderboard(
  p_room_code text,
  p_access_token text
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
  from public.sessions s
  where s.room_code = upper(trim(p_room_code))
    and (
      s.host_secret_hash = public.token_hash(p_access_token)
      or exists (
        select 1 from public.session_players p
        where p.session_id = s.id
          and p.player_token_hash = public.token_hash(p_access_token)
      )
    );
  if not found then raise exception 'Room access denied'; end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object('id', player.id, 'name', player.display_name, 'points', player.points)
      order by player.points desc, player.display_name asc
    )
    from (
      select p.id, p.display_name, coalesce(sum(e.points), 0) as points
      from public.session_players p
      left join public.score_events e on e.player_id = p.id and e.session_id = active_session.id
      where p.session_id = active_session.id
      group by p.id, p.display_name
    ) as player
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.get_live_leaderboard(text, text) to anon, authenticated;
