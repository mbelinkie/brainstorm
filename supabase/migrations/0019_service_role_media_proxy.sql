-- The Cloudflare media proxy uses a modern Supabase secret key, which maps to
-- service_role and bypasses RLS. Explicit table/function privileges are still
-- required for PostgREST access.

grant usage on schema public to service_role;
grant select on table public.media_assets to service_role;
grant execute on function public.can_access_live_media(text, uuid, text, text) to service_role;
