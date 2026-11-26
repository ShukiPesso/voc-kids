-- The hosted project does not expose new tables to the API roles automatically: grant explicitly.
-- Row-level security policies (previous migration) still decide which rows each family can touch.
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on public.libraries, public.family_state, public.profile_state to authenticated;
grant select on public.admins, public.scan_log to authenticated;

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

grant execute on function public.is_admin(), public.admin_exists() to anon, authenticated;
grant execute on function public.claim_admin() to authenticated;
revoke execute on function public.claim_admin() from anon, public;
