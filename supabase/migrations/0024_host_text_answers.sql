-- Retrieve the anonymous answer wall through one host-authorized database
-- operation. This avoids a partial failure between separate session and
-- submission REST reads in the Worker.

create or replace function public.get_host_text_answers(
  p_room_code text,
  p_host_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  active_session public.sessions;
  active_question jsonb;
begin
  select * into active_session
  from public.sessions
  where room_code = upper(trim(p_room_code))
    and host_secret_hash = public.token_hash(p_host_secret);
  if not found then raise exception 'Host authorization failed'; end if;

  active_question := active_session.state -> 'question';
  if active_session.phase not in ('question_locked', 'answer_reveal')
    or active_question ->> 'type' not in ('short_answer', 'fill_in_the_blank')
    or nullif(active_session.state ->> 'questionId', '') is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(trim(submission.answer #>> '{}') order by submission.submitted_at asc)
    from public.submissions submission
    where submission.session_id = active_session.id
      and submission.question_id = active_session.state ->> 'questionId'
      and jsonb_typeof(submission.answer) = 'string'
      and trim(submission.answer #>> '{}') <> ''
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.get_host_text_answers(text, text) to anon, authenticated;
