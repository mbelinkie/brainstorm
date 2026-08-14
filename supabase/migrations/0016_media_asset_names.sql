-- Human-readable names keep the private-media library practical once a quiz
-- has many similarly sized files. Names are author-only metadata.

alter table public.media_assets
  add column if not exists display_name text;

create or replace function public.rename_media_asset(
  p_asset_id uuid,
  p_display_name text
)
returns public.media_assets
language plpgsql
security definer
set search_path = public
as $$
declare asset public.media_assets;
begin
  if not public.is_quiz_author() then raise exception 'You are not allowed to rename media assets'; end if;
  update public.media_assets
  set display_name = nullif(left(trim(p_display_name), 160), '')
  where id = p_asset_id
  returning * into asset;
  if not found then raise exception 'Media asset not found'; end if;
  return asset;
end;
$$;

grant execute on function public.rename_media_asset(uuid, text) to authenticated;
