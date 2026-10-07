-- 0045_player_battle_submission_state.sql
-- Add the caller's authoritative submission outcome to the existing player
-- projection. Status comes only from the entry timestamps already written by
-- submit_battle_entry() and lock_battle_prompt().

create or replace function public.get_player_battle_state(
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
  active_entry public.session_battle_entries;
  own_prompt_text text;
  attempt_budget integer;
begin
  select s.* into active_session
  from public.sessions s
  join public.session_players p on p.session_id = s.id
  where s.room_code = upper(trim(p_room_code))
    and p.player_token_hash = public.token_hash(p_player_token);
  if not found then raise exception 'Player is not in this room'; end if;
  select * into active_player from public.session_players
  where session_id = active_session.id and player_token_hash = public.token_hash(p_player_token);

  if active_session.phase::text not in ('battle_prompt', 'battle_review', 'battle_vote', 'battle_result') then
    return jsonb_build_object('roomCode', active_session.room_code, 'phase', active_session.phase, 'entry', null);
  end if;

  select e.* into active_entry
  from public.session_battle_entries e
  join public.session_battle_matchups m on m.id = e.matchup_id
  where m.session_id = active_session.id
    and m.round_index = active_session.current_round_index
    and e.player_id = active_player.id;
  if not found then return jsonb_build_object('roomCode', active_session.room_code, 'phase', active_session.phase, 'entry', null); end if;

  select m.prompt_text, (q.definition -> 'rounds' -> m.round_index -> 'engine' ->> 'attemptBudget')::integer
  into own_prompt_text, attempt_budget
  from public.session_battle_matchups m
  join public.quiz_versions q on q.id = active_session.quiz_version_id
  where m.id = active_entry.matchup_id;

  return jsonb_build_object(
    'roomCode', active_session.room_code,
    'phase', active_session.phase,
    'entry', jsonb_build_object(
      'promptText', own_prompt_text,
      'attemptsRemaining', greatest(attempt_budget - active_entry.attempts_used, 0),
      'generations', coalesce((
        select jsonb_agg(jsonb_build_object(
          'attemptIndex', g.attempt_index,
          'status', g.status,
          'assetIds', to_jsonb(g.asset_ids)
        ) order by g.attempt_index)
        from public.session_battle_generations g
        where g.entry_id = active_entry.id
      ), '[]'::jsonb),
      'submissionStatus', case
        when active_entry.forfeited_at is not null then 'forfeited'
        when active_entry.submitted_at is not null then 'submitted'
        else 'open'
      end
    )
  );
end;
$$;
