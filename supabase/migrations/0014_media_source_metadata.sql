-- Keep author-only provenance for suggested/approved images. Player payloads
-- are allowlisted in the app and never include this optional metadata.

alter table public.media_assets
  add column if not exists source_url text,
  add column if not exists source_title text,
  add column if not exists source_license text;

create or replace function public.register_media_asset_with_source(
  p_storage_path text,
  p_kind text,
  p_mime_type text,
  p_byte_size integer,
  p_source_url text default null,
  p_source_title text default null,
  p_source_license text default null
)
returns public.media_assets
language plpgsql
security definer
set search_path = public, storage
as $$
declare asset public.media_assets;
begin
  if not public.is_quiz_author() then raise exception 'You are not allowed to register media assets'; end if;
  if p_kind not in ('audio', 'image') then raise exception 'Unsupported media kind'; end if;
  if p_byte_size <= 0 or p_byte_size > 26214400 then raise exception 'Media files must be between 1 byte and 25 MB'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'quiz-media' and name = p_storage_path) then raise exception 'Uploaded media object was not found'; end if;
  insert into public.media_assets (storage_path, kind, mime_type, byte_size, uploaded_by, source_url, source_title, source_license)
  values (p_storage_path, p_kind, p_mime_type, p_byte_size, auth.uid(), nullif(trim(p_source_url), ''), nullif(trim(p_source_title), ''), nullif(trim(p_source_license), ''))
  returning * into asset;
  return asset;
end;
$$;

grant execute on function public.register_media_asset_with_source(text, text, text, integer, text, text, text) to authenticated;
