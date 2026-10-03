-- Vendixa Sprint 5.8. Active/trial entitlements grant access immediately.
-- current_period_start may point to the next paid accounting period after an
-- early activation or renewal; status plus a future end date control access.
begin;
create or replace function public.business_access(p_business uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.businesses b join public.business_subscriptions s on s.business_id=b.id
 where b.id=p_business and b.is_active and s.status in ('trialing','active') and s.current_period_end>now())
$$;
revoke all on function public.business_access(uuid) from public,anon,authenticated;
grant execute on function public.business_access(uuid) to service_role;
commit;
