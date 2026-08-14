-- Let players join after play begins and give first-time late joiners a
-- server-authoritative catch-up multiplier for one upcoming round.

alter table public.session_players
  add column if not exists late_join_multiplier numeric(6,2)
    check (late_join_multiplier is null or (late_join_multiplier > 1 and late_join_multiplier <= 2)),
  add column if not exists late_join_target_round_index integer
    check (late_join_target_round_index is null or late_join_target_round_index >= 0);

create or replace function public.join_live_room(
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
  quiz_definition jsonb;
  safe_logo_key text;
  total_rounds integer;
  bonus_target integer;
  bonus_multiplier numeric(6,2);
begin
  if char_length(p_player_token) < 24 then
    raise exception 'Player token must be at least 24 characters';
  end if;

  safe_logo_key := lower(trim(coalesce(p_logo_key, 'spark')));
  if safe_logo_key !~ '^[a-z0-9-]{1,40}$' then
    raise exception 'Invalid player logo';
  end if;

  select * into active_session
  from public.sessions
  where room_code = upper(trim(p_room_code))
  for update;
  if not found then raise exception 'Room not found'; end if;
  if active_session.phase = 'complete' then raise exception 'This game has finished'; end if;

  -- The next playable round is the current round when the room is already at
  -- its between-round doorway/first-question lobby; otherwise it is the next
  -- authored round. The opening lobby never creates a catch-up bonus.
  if active_session.started_at is not null then
    select definition into quiz_definition
    from public.quiz_versions
    where id = active_session.quiz_version_id;
    total_rounds := jsonb_array_length(coalesce(quiz_definition -> 'rounds', '[]'::jsonb));
    bonus_target := case
      when active_session.phase::text in ('door_choice', 'door_reveal') then active_session.current_round_index
      when active_session.phase = 'lobby' and active_session.current_question_index = 0 then active_session.current_round_index
      -- A final-round join has no future authored round, so apply the boost to
      -- the remainder of the final round instead of silently withholding it.
      else least(active_session.current_round_index + 1, total_rounds - 1)
    end;
    if total_rounds > 1 and bonus_target > 0 and bonus_target < total_rounds then
      bonus_multiplier := round(least(2::numeric, 1 + bonus_target::numeric / (total_rounds - 1)), 2);
    end if;
  end if;

  insert into public.session_players (
    session_id, player_token_hash, display_name, logo_key,
    late_join_multiplier, late_join_target_round_index
  ) values (
    active_session.id, public.token_hash(p_player_token), trim(p_display_name), safe_logo_key,
    bonus_multiplier, case when bonus_multiplier is null then null else bonus_target end
  )
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
    'state', active_session.state,
    'lateJoinBonus', case
      when active_player.late_join_multiplier is null then null
      else jsonb_build_object(
        'multiplier', active_player.late_join_multiplier,
        'targetRoundIndex', active_player.late_join_target_round_index
      )
    end
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
  active_player public.session_players;
begin
  select s.* into active_session
  from public.sessions s
  join public.session_players p on p.session_id = s.id
  where s.room_code = upper(trim(p_room_code))
    and p.player_token_hash = public.token_hash(p_player_token);
  if not found then raise exception 'Player is not in this room'; end if;
  select * into active_player
  from public.session_players
  where session_id = active_session.id
    and player_token_hash = public.token_hash(p_player_token);

  return jsonb_build_object(
    'roomCode', active_session.room_code,
    'revision', active_session.revision,
    'phase', active_session.phase,
    'roundIndex', active_session.current_round_index,
    'questionIndex', active_session.current_question_index,
    'state', active_session.state,
    'lateJoinBonus', case
      when active_player.late_join_multiplier is null then null
      else jsonb_build_object(
        'multiplier', active_player.late_join_multiplier,
        'targetRoundIndex', active_player.late_join_target_round_index
      )
    end
  );
end;
$$;

-- Door rewards and catch-up boosts do not multiply together. The higher one
-- wins, so a catch-up player is never penalized by a door, while the 3x Hail
-- Mary outcome can still beat a catch-up boost. This trigger keeps that rule
-- at the final server-side score boundary.
create or replace function public.apply_late_join_catch_up()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_round integer;
  catch_up_multiplier numeric(6,2);
  combined_multiplier numeric(6,2);
begin
  if new.created_by <> 'system' or new.base_points is null then return new; end if;

  select s.current_round_index, p.late_join_multiplier
  into current_round, catch_up_multiplier
  from public.sessions s
  join public.session_players p on p.session_id = s.id and p.id = new.player_id
  where s.id = new.session_id
    and p.late_join_target_round_index = s.current_round_index;

  if catch_up_multiplier is null then return new; end if;
  combined_multiplier := greatest(coalesce(new.multiplier, 1), catch_up_multiplier);
  -- Preserve a door outcome when it is already the stronger multiplier (and
  -- preserve its score-event explanation). Otherwise the catch-up boost wins.
  if coalesce(new.multiplier, 1) >= catch_up_multiplier then return new; end if;
  new.multiplier := combined_multiplier;
  new.points := round(new.base_points * combined_multiplier, 2);
  new.reason := regexp_replace(new.reason, ' · [0-9.]+x door bonus$', '')
    || format(' · %sx catch-up boost', combined_multiplier);
  return new;
end;
$$;

drop trigger if exists score_events_late_join_catch_up on public.score_events;
create trigger score_events_late_join_catch_up
before insert on public.score_events
for each row execute function public.apply_late_join_catch_up();

grant execute on function public.join_live_room(text, text, text, text) to anon, authenticated;
grant execute on function public.get_live_room_state(text, text) to anon, authenticated;
