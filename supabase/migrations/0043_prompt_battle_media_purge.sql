-- 0043_prompt_battle_media_purge.sql
-- Prompt Battle (issue #38): purge battle images 30 days after creation.
--
-- Spec: docs/superpowers/specs/2026-08-26-prompt-battle-architecture.md
-- (retention) and the base design. The Worker stamps every generated image
-- with media_assets.expires_at = created + 30 days (cloudflare-worker.js,
-- BATTLE_ASSET_EXPIRY_DAYS); nothing deleted them until now.
--
-- Two phases, because the object and the row live in different places.
-- Supabase refuses direct SQL deletes from storage.objects, so the Worker
-- removes objects through the Storage API (#39, cron), between these calls:
--
--   1. purge_expired_battle_media(limit) lists expired battle images as
--      { assetId, storagePath }. It writes nothing.
--   2. The Worker deletes those objects from Storage.
--   3. finalize_battle_media_purge(assetIds) deletes the rows, but only for
--      assets that are battle-sourced, expired, AND whose storage object is
--      already gone. An object the Worker failed to delete keeps its row, so
--      the next run lists it again instead of orphaning a file nobody can
--      find. Calling it twice is harmless: the second call finds nothing.
--
-- Author media is never touched: every statement filters source = 'battle'
-- and a non-null expires_at in the past, so an author asset cannot be listed
-- or deleted whatever IDs are passed in.
--
-- References. session_battle_entries.submitted_asset_id has a foreign key to
-- media_assets (0036), and session_battle_generations.asset_ids lists IDs
-- without one (0037). Finalize clears both before deleting the row, so the
-- entry, its votes and its score events survive with the image gone. The
-- resolved result snapshot on session_battle_matchups.result (0042) keeps its
-- asset IDs as history; can_access_live_media() denies a missing asset.
--
-- Service role only: the Worker is the only caller. Additive: no table,
-- column, policy or browser grant changes.

create or replace function public.purge_expired_battle_media(p_limit integer default 100)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object('assetId', expired.id, 'storagePath', expired.storage_path) order by expired.expires_at, expired.id), '[]'::jsonb)
  from (
    select a.id, a.storage_path, a.expires_at
    from public.media_assets a
    where a.source = 'battle'
      and a.expires_at is not null
      and a.expires_at <= now()
    order by a.expires_at, a.id
    limit greatest(1, least(coalesce(p_limit, 100), 1000))
  ) as expired;
$$;

create or replace function public.finalize_battle_media_purge(p_asset_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  purgeable uuid[];
  kept uuid[];
begin
  -- Expired battle assets from the list whose object the Worker has removed.
  select coalesce(array_agg(a.id order by a.id), '{}')
  into purgeable
  from public.media_assets a
  where a.id = any(coalesce(p_asset_ids, '{}'))
    and a.source = 'battle'
    and a.expires_at is not null
    and a.expires_at <= now()
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'quiz-media' and o.name = a.storage_path
    );

  -- Listed, expired battle assets whose object is still in Storage: left for
  -- the next run, and reported so the Worker can log it.
  select coalesce(array_agg(a.id order by a.id), '{}')
  into kept
  from public.media_assets a
  where a.id = any(coalesce(p_asset_ids, '{}'))
    and a.source = 'battle'
    and a.expires_at is not null
    and a.expires_at <= now()
    and a.id <> all(purgeable);

  if cardinality(purgeable) > 0 then
    update public.session_battle_entries
    set submitted_asset_id = null
    where submitted_asset_id = any(purgeable);

    update public.session_battle_generations g
    set asset_ids = coalesce((
      select array_agg(asset_id order by ordinality)
      from unnest(g.asset_ids) with ordinality as listed(asset_id, ordinality)
      where asset_id <> all(purgeable)
    ), '{}')
    where g.asset_ids && purgeable;

    delete from public.media_assets where id = any(purgeable);
  end if;

  return jsonb_build_object('deleted', to_jsonb(purgeable), 'keptObjectStillPresent', to_jsonb(kept));
end;
$$;

revoke all on function public.purge_expired_battle_media(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_battle_media(integer) to service_role;
revoke all on function public.finalize_battle_media_purge(uuid[]) from public, anon, authenticated;
grant execute on function public.finalize_battle_media_purge(uuid[]) to service_role;
