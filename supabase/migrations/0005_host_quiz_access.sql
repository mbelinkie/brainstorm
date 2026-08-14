-- The host needs the full quiz definition (including answer keys) to run a
-- session. Players never call this function; their state comes from the
-- public session snapshot instead.

create or replace function public.get_host_quiz_definition(
  p_room_code text,
  p_host_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  definition jsonb;
begin
  select qv.definition into definition
  from public.sessions s
  join public.quiz_versions qv on qv.id = s.quiz_version_id
  where s.room_code = upper(trim(p_room_code))
    and s.host_secret_hash = public.token_hash(p_host_secret);
  if definition is null then raise exception 'Host authorization failed'; end if;
  return definition;
end;
$$;

grant execute on function public.get_host_quiz_definition(text, text) to anon, authenticated;
