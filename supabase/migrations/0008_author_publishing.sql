-- Authenticated author accounts are explicitly allowlisted. This keeps the
-- public room/phone experience anonymous while protecting quiz publication.

create table public.quiz_authors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

alter table public.quiz_authors enable row level security;

create or replace function public.is_quiz_author()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.quiz_authors where user_id = auth.uid());
$$;

create or replace function public.publish_quiz_version(p_definition jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_quiz public.quizzes;
  v_version integer;
  v_quiz_version public.quiz_versions;
begin
  if not public.is_quiz_author() then
    raise exception 'You are not allowed to publish quiz versions';
  end if;
  if coalesce(trim(p_definition ->> 'id'), '') = '' then
    raise exception 'A quiz needs a stable ID before it can be published';
  end if;
  if coalesce(trim(p_definition ->> 'title'), '') = '' or jsonb_typeof(p_definition -> 'rounds') <> 'array' then
    raise exception 'A quiz needs a title and a rounds array';
  end if;

  v_slug := trim(both '-' from regexp_replace(lower(p_definition ->> 'id'), '[^a-z0-9]+', '-', 'g'));
  if v_slug = '' then raise exception 'Quiz ID must include a letter or number'; end if;

  insert into public.quizzes (slug, title)
  values (v_slug, trim(p_definition ->> 'title'))
  on conflict (slug) do update set title = excluded.title, updated_at = now()
  returning * into v_quiz;

  select coalesce(max(version), 0) + 1 into v_version
  from public.quiz_versions where quiz_id = v_quiz.id;
  insert into public.quiz_versions (quiz_id, version, definition)
  values (v_quiz.id, v_version, p_definition)
  returning * into v_quiz_version;

  return jsonb_build_object('quizVersionId', v_quiz_version.id, 'title', v_quiz.title, 'version', v_quiz_version.version);
end;
$$;

grant execute on function public.publish_quiz_version(jsonb) to authenticated;
