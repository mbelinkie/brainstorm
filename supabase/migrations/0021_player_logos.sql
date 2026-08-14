-- Square player logos are selected at join and exposed only by their stable
-- asset key. Image paths remain a client-side design concern.

alter table public.session_players
  add column if not exists logo_key text not null default 'spark'
  check (logo_key ~ '^[a-z0-9-]{1,40}$');

drop function if exists public.join_live_room(text, text, text);

create function public.join_live_room(
  p_room_code text,
  p_display_name text,
  p_player_token text,
  p_logo_key text default 'spark'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  active_player public.session_players;
  safe_logo_key text;
begin
  if char_length(p_player_token) < 24 then
    raise exception 'Player token must be at least 24 characters';
  end if;

  safe_logo_key := lower(trim(coalesce(p_logo_key, 'spark')));
  if safe_logo_key !~ '^[a-z0-9-]{1,40}$' then
    raise exception 'Invalid player logo';
  end if;

  select * into active_session from public.sessions where room_code = upper(trim(p_room_code));
  if not found then raise exception 'Room not found'; end if;
  if active_session.phase = 'complete' then raise exception 'This game has finished'; end if;

  insert into public.session_players (session_id, player_token_hash, display_name, logo_key)
  values (active_session.id, public.token_hash(p_player_token), trim(p_display_name), safe_logo_key)
  on conflict (session_id, player_token_hash)
  do update set last_seen_at = now(), logo_key = excluded.logo_key
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

grant execute on function public.join_live_room(text, text, text, text) to anon, authenticated;

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
      jsonb_build_object('id', player.id, 'name', player.display_name, 'logoKey', player.logo_key, 'points', player.points)
      order by player.points desc, player.display_name asc
    )
    from (
      select p.id, p.display_name, p.logo_key, coalesce(sum(e.points), 0) as points
      from public.session_players p
      left join public.score_events e on e.player_id = p.id and e.session_id = active_session.id
      where p.session_id = active_session.id
      group by p.id, p.display_name, p.logo_key
    ) as player
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.get_live_leaderboard(text, text) to anon, authenticated;
