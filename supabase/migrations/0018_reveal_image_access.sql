-- A reveal-only image is public to joined players only after the host moves
-- the active question to answer reveal. It remains unavailable while answers
-- are open or locked.

create or replace function public.can_access_live_media(
  p_room_code text,
  p_asset_id uuid,
  p_host_secret text default null,
  p_player_token text default null
)
returns boolean language plpgsql security definer set search_path = public as $$
declare active_session public.sessions;
begin
  select * into active_session from public.sessions where room_code = upper(trim(p_room_code));
  if not found then return false; end if;
  if p_host_secret is not null and active_session.host_secret_hash = public.token_hash(p_host_secret) then
    return exists (select 1 from public.quiz_versions q where q.id = active_session.quiz_version_id and position(p_asset_id::text in q.definition::text) > 0);
  end if;
  if p_player_token is not null and exists (select 1 from public.session_players p where p.session_id = active_session.id and p.player_token_hash = public.token_hash(p_player_token)) then
    return active_session.state @> jsonb_build_object('question', jsonb_build_object('options', jsonb_build_array(jsonb_build_object('imageAssetId', p_asset_id::text))) )
      or (active_session.phase = 'answer_reveal' and active_session.state @> jsonb_build_object('revealImageAssetId', p_asset_id::text));
  end if;
  return false;
end;
$$;

grant execute on function public.can_access_live_media(text, uuid, text, text) to anon, authenticated;
