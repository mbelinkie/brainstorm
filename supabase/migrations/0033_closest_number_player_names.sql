-- The /host-closest-number-guesses Worker endpoint verifies the host secret
-- before this read. Direct table access remains unavailable to browser roles and
-- is granted only to the Worker's service role for display lookups. Player names
-- deliberately stay out of the public room state which is broadcast to every
-- player phone.

grant select on table public.session_players to service_role;
