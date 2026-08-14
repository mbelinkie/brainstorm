-- Private, author-managed media. Files stay in a Supabase private bucket and
-- are served to the host through the application Worker after room-secret
-- verification; player clients never receive a media path or URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'quiz-media',
  'quiz-media',
  false,
  26214400,
  array['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null unique check (storage_path !~ '[[:space:]]'),
  kind text not null check (kind in ('audio', 'image')),
  mime_type text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 26214400),
  uploaded_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.media_assets enable row level security;

create policy "Quiz authors can read media records"
on public.media_assets for select to authenticated
using (public.is_quiz_author());

create policy "Quiz authors can upload media objects"
on storage.objects for insert to authenticated
with check (bucket_id = 'quiz-media' and public.is_quiz_author());

create policy "Quiz authors can read media objects"
on storage.objects for select to authenticated
using (bucket_id = 'quiz-media' and public.is_quiz_author());

create policy "Quiz authors can update media objects"
on storage.objects for update to authenticated
using (bucket_id = 'quiz-media' and public.is_quiz_author())
with check (bucket_id = 'quiz-media' and public.is_quiz_author());

create policy "Quiz authors can delete media objects"
on storage.objects for delete to authenticated
using (bucket_id = 'quiz-media' and public.is_quiz_author());

create or replace function public.register_media_asset(
  p_storage_path text,
  p_kind text,
  p_mime_type text,
  p_byte_size integer
)
returns public.media_assets
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  asset public.media_assets;
begin
  if not public.is_quiz_author() then raise exception 'You are not allowed to register media assets'; end if;
  if p_kind not in ('audio', 'image') then raise exception 'Unsupported media kind'; end if;
  if p_byte_size <= 0 or p_byte_size > 26214400 then raise exception 'Media files must be between 1 byte and 25 MB'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'quiz-media' and name = p_storage_path) then raise exception 'Uploaded media object was not found'; end if;

  insert into public.media_assets (storage_path, kind, mime_type, byte_size, uploaded_by)
  values (p_storage_path, p_kind, p_mime_type, p_byte_size, auth.uid())
  returning * into asset;
  return asset;
end;
$$;

grant execute on function public.register_media_asset(text, text, text, integer) to authenticated;
