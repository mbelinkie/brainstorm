-- The answer-wall Worker verifies the host secret before these reads. Direct
-- table access remains unavailable to browser roles and is granted only to the
-- Worker's server-side service role for refresh/reconnect recovery.

grant select on table public.sessions to service_role;
grant select on table public.submissions to service_role;
