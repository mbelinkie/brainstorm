-- The private-media RLS policy correctly restricts rows to allowlisted quiz
-- authors, but RLS policies do not replace the underlying table privilege.
-- Without this grant PostgREST returns “permission denied for table
-- media_assets” before it can evaluate the author policy.

grant select on table public.media_assets to authenticated;
