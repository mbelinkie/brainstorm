-- Public catalog contains only host-facing titles and version IDs. Quiz
-- definitions and answer keys stay behind the host-secret RPC.

create or replace function public.list_quiz_catalog()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'quizVersionId', entry.id,
      'title', entry.title,
      'version', entry.version
    ) order by entry.title asc, entry.version desc
  ), '[]'::jsonb)
  from (
    select qv.id, q.title, qv.version
    from public.quizzes q
    join public.quiz_versions qv on qv.quiz_id = q.id
  ) as entry;
$$;

grant execute on function public.list_quiz_catalog() to anon, authenticated;
