-- Rendered presentation video derivatives are private author-managed assets.
-- The raw source never enters Storage: only a normalized, bounded MP4 does.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quiz-media', 'quiz-media', false, 26214400, array['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table public.media_assets drop constraint if exists media_assets_kind_check;
alter table public.media_assets add constraint media_assets_kind_check check (kind in ('audio', 'image', 'video'));
alter table public.media_assets
  add column if not exists duration_ms integer check (duration_ms is null or duration_ms > 0),
  add column if not exists width integer check (width is null or width > 0),
  add column if not exists height integer check (height is null or height > 0),
  add column if not exists has_audio boolean;

create or replace function public.register_video_media_asset(
  p_storage_path text,
  p_mime_type text,
  p_byte_size integer,
  p_duration_ms integer,
  p_width integer,
  p_height integer,
  p_has_audio boolean
)
returns public.media_assets
language plpgsql
security definer
set search_path = public, storage
as $$
declare asset public.media_assets;
begin
  if not public.is_quiz_author() then raise exception 'You are not allowed to register video media assets'; end if;
  if p_mime_type <> 'video/mp4' then raise exception 'Only standardized video/mp4 derivatives are supported'; end if;
  if p_byte_size <= 0 or p_byte_size > 26214400 then raise exception 'Video files must be between 1 byte and 25 MB'; end if;
  if p_duration_ms <= 0 or p_duration_ms > 45000 then raise exception 'Video duration must be between 1 ms and 45 seconds'; end if;
  if p_width <= 0 or p_height <= 0 or p_width > 1280 or p_height > 720 then raise exception 'Video dimensions must not exceed 1280×720'; end if;
  if p_storage_path !~ ('^' || auth.uid()::text || '/[0-9a-f-]{36}[.]mp4$') then raise exception 'Video storage path is invalid'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'quiz-media' and name = p_storage_path and metadata->>'mimetype' = 'video/mp4') then raise exception 'Uploaded MP4 object was not found'; end if;
  insert into public.media_assets (storage_path, kind, mime_type, byte_size, duration_ms, width, height, has_audio, uploaded_by)
  values (p_storage_path, 'video', p_mime_type, p_byte_size, p_duration_ms, p_width, p_height, p_has_audio, auth.uid())
  returning * into asset;
  return asset;
end;
$$;

grant execute on function public.register_video_media_asset(text, text, integer, integer, integer, integer, boolean) to authenticated;
