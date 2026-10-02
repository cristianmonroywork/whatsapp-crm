-- Vendixa Sprint 5.8. Apply only to the verified Vendixa Supabase project after 007.
-- Existing active businesses receive a dated 30-day courtesy bridge; no perpetual grants.
begin;
create table public.business_subscriptions (
 business_id uuid primary key references public.businesses(id), plan text not null default 'vendixa_monthly' check(plan='vendixa_monthly'),
 status text not null check(status in ('trialing','active','past_due','suspended','expired','canceled')),
 source text not null check(source in ('trial','mercado_pago','manual_cash','manual_transfer','manual_other','promo','courtesy')),
 starts_at timestamptz not null, current_period_start timestamptz not null, current_period_end timestamptz not null,
 trial_ends_at timestamptz, cancel_at_period_end boolean not null default false,
 provider_customer_id text, provider_subscription_id text unique,
 amount_paid_cents bigint check(amount_paid_cents>=0), currency text not null default 'MXN' check(currency='MXN'),
 payment_method text, last_payment_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(current_period_end>current_period_start)
);
create table public.commercial_audit (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id),
 actor_id uuid references public.profiles(id), actor_source text not null check(actor_source in ('system','operator','mercado_pago')),
 event_type text not null, before_data jsonb, after_data jsonb, note text, created_at timestamptz not null default now()
);
create index commercial_audit_business_time on public.commercial_audit(business_id,created_at desc);
create table public.checkout_attempts (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id), actor_id uuid not null references public.profiles(id),
 provider_subscription_id text unique, init_point text, status text not null default 'created' check(status in ('created','pending','approved','canceled')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.commercial_payments (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id),
 provider text not null, external_payment_id text not null, provider_subscription_id text,
 amount_cents bigint not null check(amount_cents>=0), currency text not null default 'MXN', status text not null,
 paid_at timestamptz, created_at timestamptz not null default now(), unique(provider,external_payment_id)
);
create table public.payment_webhook_events (
 event_key text primary key, topic text not null, resource_id text not null, status text not null,
 business_id uuid references public.businesses(id), processed_at timestamptz not null default now()
);
create table public.operator_role_audit (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null references public.profiles(id),
 target_id uuid not null references public.profiles(id), action text not null check(action in ('grant','revoke')),
 created_at timestamptz not null default now()
);
alter table public.business_subscriptions enable row level security;
alter table public.commercial_audit enable row level security;
alter table public.checkout_attempts enable row level security;
alter table public.commercial_payments enable row level security;
alter table public.payment_webhook_events enable row level security;
alter table public.operator_role_audit enable row level security;
revoke all on public.business_subscriptions,public.commercial_audit,public.checkout_attempts,public.commercial_payments,public.payment_webhook_events from anon,authenticated;
grant all on public.business_subscriptions,public.commercial_audit,public.checkout_attempts,public.commercial_payments,public.payment_webhook_events to service_role;
revoke all on public.operator_role_audit from anon,authenticated;
grant all on public.operator_role_audit to service_role;

create or replace function public.manage_operator_role(p_actor uuid,p_target uuid,p_action text)
returns void language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.pilot_operators where user_id=p_actor) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_action not in ('grant','revoke') or p_actor=p_target then raise exception 'invalid operator action' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(8710049);
 if p_action='grant' then
  if not exists(select 1 from auth.users where id=p_target and email_confirmed_at is not null) then raise exception 'confirmed user required' using errcode='22023'; end if;
  insert into public.profiles(id) values(p_target) on conflict(id) do nothing;
  insert into public.pilot_operators(user_id) values(p_target) on conflict do nothing;
 else
  if (select count(*) from public.pilot_operators)<=1 then raise exception 'last operator cannot be removed' using errcode='42501'; end if;
  delete from public.pilot_operators where user_id=p_target;
 end if;
 insert into public.operator_role_audit(actor_id,target_id,action) values(p_actor,p_target,p_action);
end $$;
revoke all on function public.manage_operator_role(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.manage_operator_role(uuid,uuid,text) to service_role;

create or replace function public.business_access(p_business uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.businesses b join public.business_subscriptions s on s.business_id=b.id
 where b.id=p_business and b.is_active and s.status in ('trialing','active') and s.current_period_start<=now() and s.current_period_end>now())
$$;
revoke all on function public.business_access(uuid) from public,anon,authenticated;
grant execute on function public.business_access(uuid) to service_role;

-- The database also enforces the gate, including direct service-role RPC calls.
create or replace function public.enforce_commercial_write() returns trigger language plpgsql security definer set search_path=public as $$
declare bid uuid; intent text; operations jsonb;
begin
 bid:=coalesce(new.business_id,old.business_id);
 if tg_table_name='messages' then
  intent:=new.interpretation->>'intent'; operations:=new.interpretation->'operations';
  if intent in ('clarify','totals','balance','debtors','summary','comparison','best_day','business_overview') then return new; end if;
  if intent='inventory' and jsonb_typeof(operations)='array' and jsonb_array_length(operations)=1
   and operations->0->>'intent' in ('inventory_list','inventory_count','inventory_value','inventory_top') then return new; end if;
 end if;
 if not public.business_access(bid) then raise exception 'subscription inactive' using errcode='42501'; end if;
 return new;
end $$;
drop trigger if exists commercial_messages_gate on public.messages;
create trigger commercial_messages_gate before insert on public.messages for each row execute function public.enforce_commercial_write();
create trigger commercial_movements_gate before insert or update on public.movements for each row execute function public.enforce_commercial_write();
create trigger commercial_inventory_gate before insert or update on public.inventory_movements for each row execute function public.enforce_commercial_write();
create trigger commercial_products_gate before insert or update on public.products for each row execute function public.enforce_commercial_write();
create trigger commercial_pending_gate before insert or update on public.pending_actions for each row execute function public.enforce_commercial_write();

create or replace function public.create_business_trial(p_actor uuid,p_name text,p_timezone text,p_trial_days integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.businesses%rowtype; until_at timestamptz;
begin
 if not exists(select 1 from auth.users where id=p_actor) then raise exception 'unauthorized' using errcode='42501'; end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 120 or not exists(select 1 from pg_timezone_names where name=p_timezone)
  or p_trial_days not between 1 and 30 then raise exception 'invalid onboarding' using errcode='22023'; end if;
 insert into public.profiles(id) values(p_actor) on conflict(id) do nothing;
 perform 1 from public.profiles where id=p_actor for update;
 if exists(select 1 from public.memberships where user_id=p_actor) then raise exception 'business already exists' using errcode='23505'; end if;
 insert into public.businesses(name,timezone,is_pilot) values(trim(p_name),p_timezone,false) returning * into b;
 insert into public.memberships(business_id,user_id,role) values(b.id,p_actor,'owner');
 until_at:=now()+make_interval(days=>p_trial_days);
 insert into public.business_subscriptions(business_id,status,source,starts_at,current_period_start,current_period_end,trial_ends_at)
 values(b.id,'trialing','trial',now(),now(),until_at,until_at);
 insert into public.commercial_audit(business_id,actor_id,actor_source,event_type,after_data)
 values(b.id,p_actor,'system','trial_started',jsonb_build_object('status','trialing','expires_at',until_at));
 return jsonb_build_object('id',b.id,'name',b.name,'timezone',b.timezone,'status','trialing','current_period_end',until_at);
end $$;
revoke all on function public.create_business_trial(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.create_business_trial(uuid,text,text,integer) to service_role;

-- Temporary compatibility for the pre-deployment invite endpoint during rollout.
create or replace function public.legacy_pilot_trial() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.is_pilot then
  insert into public.business_subscriptions(business_id,status,source,starts_at,current_period_start,current_period_end,trial_ends_at)
  values(new.id,'trialing','trial',now(),now(),now()+interval '7 days',now()+interval '7 days');
  insert into public.commercial_audit(business_id,actor_source,event_type,after_data,note)
  values(new.id,'system','trial_started',jsonb_build_object('status','trialing'),'Legacy invitation onboarding');
 end if;
 return new;
end $$;
create trigger legacy_pilot_trial_trigger after insert on public.businesses for each row execute function public.legacy_pilot_trial();

create or replace function public.refresh_commercial_expiry(p_business uuid)
returns void language plpgsql security definer set search_path=public as $$
declare s public.business_subscriptions%rowtype;
begin
 select * into s from public.business_subscriptions where business_id=p_business for update;
 if found and s.status in ('trialing','active') and s.current_period_end<=now() then
  update public.business_subscriptions set status='expired',updated_at=now() where business_id=p_business;
  insert into public.commercial_audit(business_id,actor_source,event_type,before_data,after_data)
  values(p_business,'system',case when s.status='trialing' then 'trial_expired' else 'subscription_expired' end,
   to_jsonb(s),(select to_jsonb(x) from public.business_subscriptions x where x.business_id=p_business));
 end if;
end $$;
revoke all on function public.refresh_commercial_expiry(uuid) from public,anon,authenticated;
grant execute on function public.refresh_commercial_expiry(uuid) to service_role;

create or replace function public.commercial_access_state(p_actor uuid,p_business uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.businesses%rowtype; s public.business_subscriptions%rowtype; effective text;
begin
 select * into b from public.businesses where id=p_business;
 if not found or not exists(select 1 from public.memberships where user_id=p_actor and business_id=p_business) then raise exception 'forbidden' using errcode='42501'; end if;
 perform public.refresh_commercial_expiry(p_business);
 select * into s from public.business_subscriptions where business_id=p_business;
 effective:=case when not b.is_active then 'suspended' when s.business_id is null then 'expired'
  when s.status in ('trialing','active') and s.current_period_end<=now() then 'expired' else s.status end;
 return jsonb_build_object('business_id',p_business,'plan',s.plan,'status',effective,'source',s.source,
  'starts_at',s.starts_at,'current_period_end',s.current_period_end,'trial_ends_at',s.trial_ends_at,
  'can_write',public.business_access(p_business));
end $$;
revoke all on function public.commercial_access_state(uuid,uuid) from public,anon,authenticated;
grant execute on function public.commercial_access_state(uuid,uuid) to service_role;

create or replace function public.operator_subscription_action(p_actor uuid,p_business uuid,p_action text,p_source text,
 p_start timestamptz,p_end timestamptz,p_amount_cents bigint,p_note text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.business_subscriptions%rowtype; old_data jsonb; effective_start timestamptz; effective_end timestamptz; event_name text;
begin
 if not exists(select 1 from public.pilot_operators where user_id=p_actor) then raise exception 'forbidden' using errcode='42501'; end if;
 perform 1 from public.businesses where id=p_business for update;
 if not found then raise exception 'business missing' using errcode='22023'; end if;
 select * into s from public.business_subscriptions where business_id=p_business for update;
 if not found then raise exception 'subscription missing' using errcode='22023'; end if;
 old_data:=to_jsonb(s);
 if p_action in ('activate','renew') then
  if p_source not in ('manual_cash','manual_transfer','manual_other','promo','courtesy') or p_amount_cents is not null and p_amount_cents<0
   or length(coalesce(p_note,''))>500 then raise exception 'invalid manual activation' using errcode='22023'; end if;
  if p_action='activate' then effective_start:=coalesce(p_start,now());effective_end:=p_end;
  else effective_start:=greatest(now(),s.current_period_end);effective_end:=coalesce(p_end,effective_start+interval '30 days'); end if;
  if effective_end is null or effective_end<=effective_start or effective_end>effective_start+interval '366 days' then raise exception 'invalid expiry' using errcode='22023'; end if;
  update public.business_subscriptions set status='active',source=p_source,starts_at=case when p_action='activate' then effective_start else starts_at end,
   current_period_start=effective_start,current_period_end=effective_end,amount_paid_cents=p_amount_cents,
   payment_method=p_source,last_payment_at=case when p_amount_cents is not null then now() else last_payment_at end,
   cancel_at_period_end=false,updated_at=now() where business_id=p_business returning * into s;
  event_name:=case when p_action='renew' then 'manual_renewal' else 'manual_activation' end;
 elsif p_action='suspend' then
  update public.business_subscriptions set status='suspended',updated_at=now() where business_id=p_business returning * into s;
  event_name:='subscription_suspended';
 elsif p_action='cancel' then
  if s.source='mercado_pago' and s.provider_subscription_id is not null then raise exception 'cancel at provider first' using errcode='22023'; end if;
  update public.business_subscriptions set status='canceled',updated_at=now() where business_id=p_business returning * into s;
  event_name:='subscription_canceled';
 else raise exception 'invalid action' using errcode='22023'; end if;
 insert into public.commercial_audit(business_id,actor_id,actor_source,event_type,before_data,after_data,note)
 values(p_business,p_actor,'operator',event_name,old_data,to_jsonb(s),left(p_note,500));
 return jsonb_build_object('business_id',p_business,'plan',s.plan,'status',s.status,'source',s.source,
  'current_period_end',s.current_period_end,'can_write',public.business_access(p_business));
end $$;
revoke all on function public.operator_subscription_action(uuid,uuid,text,text,timestamptz,timestamptz,bigint,text) from public,anon,authenticated;
grant execute on function public.operator_subscription_action(uuid,uuid,text,text,timestamptz,timestamptz,bigint,text) to service_role;

create or replace function public.create_checkout_attempt(p_actor uuid,p_business uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare attempt public.checkout_attempts%rowtype; current_access public.business_subscriptions%rowtype;
begin
 if not exists(select 1 from public.memberships where user_id=p_actor and business_id=p_business and role='owner') then raise exception 'forbidden' using errcode='42501'; end if;
 select * into current_access from public.business_subscriptions where business_id=p_business;
 if not found then raise exception 'subscription missing' using errcode='22023'; end if;
 if current_access.status='active' and current_access.source='mercado_pago' and current_access.current_period_end>now() then raise exception 'already subscribed' using errcode='22023'; end if;
 select * into attempt from public.checkout_attempts where business_id=p_business and status='pending' order by created_at desc limit 1;
 if found then return jsonb_build_object('id',attempt.id,'business_id',attempt.business_id,'url',attempt.init_point); end if;
 insert into public.checkout_attempts(business_id,actor_id) values(p_business,p_actor) returning * into attempt;
 insert into public.commercial_audit(business_id,actor_id,actor_source,event_type,after_data)
 values(p_business,p_actor,'system','checkout_started',jsonb_build_object('attempt_id',attempt.id));
 return jsonb_build_object('id',attempt.id,'business_id',attempt.business_id);
end $$;
revoke all on function public.create_checkout_attempt(uuid,uuid) from public,anon,authenticated;
grant execute on function public.create_checkout_attempt(uuid,uuid) to service_role;

create or replace function public.link_checkout_attempt(p_attempt uuid,p_provider_subscription text,p_init_point text)
returns void language plpgsql security definer set search_path=public as $$
declare a public.checkout_attempts%rowtype;
begin
 if length(coalesce(p_provider_subscription,'')) not between 1 and 120 or p_init_point !~ '^https://(www\.)?mercadopago\.com\.mx/' then raise exception 'invalid provider id'; end if;
 select * into a from public.checkout_attempts where id=p_attempt for update;
 if not found then raise exception 'checkout missing'; end if;
 if a.status='approved' and a.provider_subscription_id=p_provider_subscription then return; end if;
 update public.checkout_attempts set provider_subscription_id=p_provider_subscription,init_point=p_init_point,status='pending',updated_at=now() where id=p_attempt and status='created';
 if not found then raise exception 'checkout already linked'; end if;
end $$;
revoke all on function public.link_checkout_attempt(uuid,text,text) from public,anon,authenticated;
grant execute on function public.link_checkout_attempt(uuid,text,text) to service_role;

-- Authenticated webhook handler verifies MP signature and fetches provider state before calling this RPC.
-- Lock business row to serialize payment, manual action and duplicate webhook delivery.
create or replace function public.apply_verified_mp_event(p_event_key text,p_topic text,p_resource_id text,p_attempt uuid,
 p_provider_subscription text,p_status text,p_amount_cents bigint,p_currency text,p_paid_at timestamptz,p_customer text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.checkout_attempts%rowtype; s public.business_subscriptions%rowtype; old_data jsonb; new_end timestamptz; event_name text; existed boolean;
begin
 if length(p_event_key) not between 1 and 240 or p_topic not in ('payment','subscription','authorized_payment')
  or p_status not in ('approved','rejected','authorized','paused','cancelled','pending')
  or p_provider_subscription is null or p_currency<>'MXN' or p_amount_cents is null or p_amount_cents<0 then raise exception 'invalid provider event' using errcode='22023'; end if;
 select * into a from public.checkout_attempts where id=p_attempt;
 if not found or (a.provider_subscription_id is not null and a.provider_subscription_id<>p_provider_subscription) then raise exception 'checkout mismatch' using errcode='42501'; end if;
 perform 1 from public.businesses where id=a.business_id for update;
 if exists(select 1 from public.payment_webhook_events where event_key=p_event_key) then return jsonb_build_object('duplicate',true); end if;
 select * into s from public.business_subscriptions where business_id=a.business_id for update;
 old_data:=to_jsonb(s);
 if p_topic in ('payment','authorized_payment') then
  select exists(select 1 from public.commercial_payments where provider='mercado_pago' and external_payment_id=p_resource_id and status='approved') into existed;
  insert into public.commercial_payments(business_id,provider,external_payment_id,provider_subscription_id,amount_cents,currency,status,paid_at)
  values(a.business_id,'mercado_pago',p_resource_id,p_provider_subscription,p_amount_cents,p_currency,p_status,p_paid_at)
  on conflict(provider,external_payment_id) do update set status=excluded.status,paid_at=excluded.paid_at;
  if p_status='approved' and not existed then
   new_end:=greatest(now(),s.current_period_end)+interval '1 month';
   update public.business_subscriptions set status='active',source='mercado_pago',current_period_start=greatest(now(),s.current_period_end),
    current_period_end=new_end,provider_subscription_id=p_provider_subscription,provider_customer_id=p_customer,
    amount_paid_cents=p_amount_cents,payment_method='mercado_pago',last_payment_at=coalesce(p_paid_at,now()),updated_at=now()
   where business_id=a.business_id returning * into s;
   update public.checkout_attempts set status='approved',provider_subscription_id=p_provider_subscription,updated_at=now() where id=a.id;
   insert into public.commercial_audit(business_id,actor_source,event_type,after_data)
   values(a.business_id,'mercado_pago','payment_approved',jsonb_build_object('payment_id',p_resource_id,'amount_cents',p_amount_cents));
   event_name:=case when old_data->>'status'='active' then 'subscription_renewed' else 'subscription_activated' end;
  elsif p_status='rejected' then
   if s.status='active' and s.current_period_end>now() then
    update public.business_subscriptions set status='past_due',updated_at=now() where business_id=a.business_id returning * into s;
   end if;
   event_name:='payment_failed';
  end if;
 elsif p_status in ('paused','cancelled') then
  update public.business_subscriptions set status=case when p_status='cancelled' then 'canceled' else 'suspended' end,updated_at=now()
   where business_id=a.business_id and provider_subscription_id=p_provider_subscription returning * into s;
  if found then event_name:='subscription_canceled'; end if;
 end if;
 insert into public.payment_webhook_events(event_key,topic,resource_id,status,business_id) values(p_event_key,p_topic,p_resource_id,p_status,a.business_id);
 if event_name is not null then
  insert into public.commercial_audit(business_id,actor_source,event_type,before_data,after_data)
  values(a.business_id,'mercado_pago',event_name,old_data,to_jsonb(s));
 end if;
 return jsonb_build_object('business_id',a.business_id,'status',s.status,'duplicate',false);
end $$;
revoke all on function public.apply_verified_mp_event(text,text,text,uuid,text,text,bigint,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.apply_verified_mp_event(text,text,text,uuid,text,text,bigint,text,timestamptz,text) to service_role;

-- Preserve existing businesses and permit a controlled, dated transition.
insert into public.business_subscriptions(business_id,status,source,starts_at,current_period_start,current_period_end)
select id,'active','courtesy',now(),now(),now()+interval '30 days' from public.businesses where is_active
on conflict(business_id) do nothing;
insert into public.commercial_audit(business_id,actor_source,event_type,after_data,note)
select business_id,'system','subscription_activated',to_jsonb(s),'Existing business: 30-day courtesy transition'
from public.business_subscriptions s where s.source='courtesy';

create or replace function public.commercial_dashboard(p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.pilot_operators where user_id=p_actor) then raise exception 'forbidden' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',b.id,'name',b.name,'user_email',u.email,'plan',s.plan,
  'status',case when not b.is_active then 'suspended' when s.status in ('trialing','active') and s.current_period_end<=now() then 'expired' else s.status end,
  'source',s.source,'starts_at',s.starts_at,'current_period_end',s.current_period_end,
  'last_payment_at',s.last_payment_at,'amount_paid_cents',s.amount_paid_cents,'payment_method',s.payment_method,
  'days_to_expiry',ceil(extract(epoch from (s.current_period_end-now()))/86400)::integer
 ) order by s.current_period_end),'[]'::jsonb) into result
 from public.businesses b join public.business_subscriptions s on s.business_id=b.id
 left join lateral (select au.email from public.memberships m join auth.users au on au.id=m.user_id
  where m.business_id=b.id and m.role='owner' order by m.user_id limit 1) u on true;
 return result;
end $$;
revoke all on function public.commercial_dashboard(uuid) from public,anon,authenticated;
grant execute on function public.commercial_dashboard(uuid) to service_role;
notify pgrst, 'reload schema';
commit;
