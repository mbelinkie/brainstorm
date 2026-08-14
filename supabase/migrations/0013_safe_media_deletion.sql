-- Delete only author-owned assets that are absent from every published quiz
-- definition. The author UI also protects assets referenced by its open draft.

create or replace function public.delete_unused_media_asset(p_asset_id uuid)
returns void
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  asset public.media_assets;
begin
  if not public.is_quiz_author() then raise exception 'You are not allowed to delete media assets'; end if;
  select * into asset from public.media_assets where id = p_asset_id for update;
  if not found then raise exception 'Media asset not found'; end if;
  if exists (select 1 from public.quiz_versions where position(p_asset_id::text in definition::text) > 0) then
    raise exception 'This media asset is used by a published quiz version';
  end if;
  delete from storage.objects where bucket_id = 'quiz-media' and name = asset.storage_path;
  delete from public.media_assets where id = asset.id;
end;
$$;

grant execute on function public.delete_unused_media_asset(uuid) to authenticated;
