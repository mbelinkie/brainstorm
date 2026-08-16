-- PostgreSQL has jsonb_array_length but no matching jsonb_object_length
-- built-in. The scoring RPC uses the latter for categorize questions.
create or replace function public.jsonb_object_length(value jsonb)
returns integer
language sql
immutable
strict
parallel safe
set search_path = pg_catalog
as $$
  select count(*)::integer
  from jsonb_object_keys(value);
$$;
