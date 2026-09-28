-- Apply ONLY to a new, isolated Supabase project. Monetary values are MXN cents.
create table public.businesses (
 id uuid primary key default gen_random_uuid(), name text not null,
 timezone text not null default 'America/Mexico_City', currency text not null default 'MXN' check(currency='MXN'),
 created_at timestamptz not null default now()
);
create function public.validate_timezone() returns trigger language plpgsql set search_path=public as $$
begin
 if not exists(select 1 from pg_timezone_names where name=new.timezone) then raise exception 'invalid timezone'; end if;
 return new;
end $$;
create trigger businesses_timezone before insert or update on public.businesses for each row execute function public.validate_timezone();
create table public.profiles (
 id uuid primary key references auth.users(id), display_name text not null default '', created_at timestamptz not null default now()
);
create table public.memberships (
 business_id uuid references public.businesses(id), user_id uuid references public.profiles(id),
 role text not null default 'owner' check(role in ('owner','member')), primary key(business_id,user_id)
);
create table public.channel_bindings (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, user_id uuid not null,
 channel text not null check(channel='whatsapp'), phone_number_id text not null, sender_id text not null,
 unique(channel,phone_number_id,sender_id), foreign key(business_id,user_id) references public.memberships(business_id,user_id)
);
create table public.contacts (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id),
 name text not null check(length(name) between 1 and 120), name_key text not null,
 unique(business_id,name_key), unique(business_id,id)
);
create table public.messages (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, actor_id uuid not null,
 channel text not null check(channel in ('web','whatsapp')), external_id text not null,
 fingerprint text not null, content text not null, media jsonb, interpretation jsonb not null,
 response jsonb, created_at timestamptz not null default now(),
 unique(business_id,channel,external_id), unique(business_id,id),
 foreign key(business_id,actor_id) references public.memberships(business_id,user_id)
);
create table public.movements (
 id uuid primary key default gen_random_uuid(), sequence bigint generated always as identity,
 business_id uuid not null references public.businesses(id), actor_id uuid not null,
 kind text not null check(kind in ('sale','expense','receivable','payment')),
 amount_cents bigint not null check(amount_cents between 1 and 100000000000),
 description text not null default '', occurred_on date not null,
 contact_id uuid, receivable_id uuid, source_message_id uuid not null,
 version integer not null default 1, voided_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(business_id,id), foreign key(business_id,actor_id) references public.memberships(business_id,user_id),
 foreign key(business_id,contact_id) references public.contacts(business_id,id),
 foreign key(business_id,receivable_id) references public.movements(business_id,id),
 foreign key(business_id,source_message_id) references public.messages(business_id,id),
 check((kind='payment')=(receivable_id is not null)),
 check(kind not in ('receivable','payment') or contact_id is not null)
);
create index movements_daily on public.movements(business_id,occurred_on,kind) where voided_at is null;
create index movements_debt on public.movements(business_id,receivable_id) where voided_at is null;
create table public.pending_actions (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, actor_id uuid not null,
 channel text not null, token text not null default upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),
 target_id uuid not null, target_version integer not null, action text not null check(action in ('correct_last','delete_last')),
 new_amount_cents bigint, source_message_id uuid not null, expires_at timestamptz not null default now()+interval '10 minutes',
 consumed_at timestamptz,
 foreign key(business_id,actor_id) references public.memberships(business_id,user_id),
 foreign key(business_id,target_id) references public.movements(business_id,id),
 foreign key(business_id,source_message_id) references public.messages(business_id,id)
);
create table public.movement_audit (
 id uuid primary key default gen_random_uuid(), business_id uuid not null, movement_id uuid not null,
 actor_id uuid not null, message_id uuid not null, action text not null,
 before_data jsonb, after_data jsonb not null, created_at timestamptz not null default now(),
 foreign key(business_id,movement_id) references public.movements(business_id,id),
 foreign key(business_id,message_id) references public.messages(business_id,id),
 foreign key(business_id,actor_id) references public.memberships(business_id,user_id)
);
-- Durable delivery status; committing a financial operation never depends on Meta availability.
create table public.outbox (
 message_id uuid primary key references public.messages(id), business_id uuid not null references public.businesses(id),
 recipient text not null, phone_number_id text not null, body text not null,
 status text not null default 'pending' check(status in ('pending','sending','sent')),
 lease_until timestamptz, attempts integer not null default 0, provider_id text, sent_at timestamptz
);
create view public.accounts_receivable with (security_invoker=true) as
 select r.business_id,r.id,r.contact_id,r.amount_cents,
 r.amount_cents-coalesce((select sum(p.amount_cents) from public.movements p where p.business_id=r.business_id and p.receivable_id=r.id and p.voided_at is null),0) as balance_cents
 from public.movements r where r.kind='receivable' and r.voided_at is null;
create view public.payments with (security_invoker=true) as select * from public.movements where kind='payment' and voided_at is null;

create function public.is_member(bid uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.memberships where business_id=bid and user_id=auth.uid())
$$;
revoke all on function public.is_member(uuid) from public;
grant execute on function public.is_member(uuid) to authenticated;
alter table public.businesses enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.channel_bindings enable row level security;
alter table public.contacts enable row level security;
alter table public.messages enable row level security;
alter table public.movements enable row level security;
alter table public.pending_actions enable row level security;
alter table public.movement_audit enable row level security;
alter table public.outbox enable row level security;
create policy own_profile on public.profiles for select to authenticated using(id=auth.uid());
create policy own_membership on public.memberships for select to authenticated using(user_id=auth.uid());
create policy member_business on public.businesses for select to authenticated using(public.is_member(id));
create policy member_contacts on public.contacts for select to authenticated using(public.is_member(business_id));
create policy member_movements on public.movements for select to authenticated using(public.is_member(business_id));
-- All writes, messages, pending actions, audit and channel bindings are server-only.
revoke all on all tables in schema public from anon,authenticated;
grant select on public.profiles,public.memberships,public.businesses,public.contacts,public.movements,public.accounts_receivable,public.payments to authenticated;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;

-- One transaction, serialized per business: receipt, mutation, audit and response.
create function public.process_command(p_business uuid,p_actor uuid,p_channel text,p_external_id text,p_fingerprint text,p_content text,p_command jsonb,p_media jsonb default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 b businesses%rowtype; oldmsg messages%rowtype; msgid uuid; m movements%rowtype; before_m jsonb;
 pending pending_actions%rowtype; result jsonb; op text:=p_command->>'intent';
 amount bigint; contact uuid; debt uuid; n integer; paid bigint; bal bigint; day date; first_day date; last_day date;
begin
 select * into b from businesses where id=p_business for update;
 if not found or not exists(select 1 from memberships where business_id=p_business and user_id=p_actor) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_channel not in ('web','whatsapp') or length(p_external_id) not between 1 and 200 or length(p_content)>4000 then raise exception 'invalid envelope'; end if;
 select * into oldmsg from messages where business_id=p_business and channel=p_channel and external_id=p_external_id;
 if found then
  if oldmsg.fingerprint<>p_fingerprint or oldmsg.actor_id<>p_actor then raise exception 'idempotency conflict' using errcode='23505'; end if;
  return oldmsg.response || jsonb_build_object('duplicate',true,'message_id',oldmsg.id);
 end if;
 insert into messages(business_id,actor_id,channel,external_id,fingerprint,content,interpretation,media)
 values(p_business,p_actor,p_channel,p_external_id,p_fingerprint,p_content,p_command,p_media) returning id into msgid;
 day:=(now() at time zone b.timezone)::date;
 if p_command->>'date'='yesterday' then day:=day-1;
 elsif p_command->>'date' ~ '^\d{4}-\d{2}-\d{2}$' then day:=(p_command->>'date')::date;
 elsif coalesce(p_command->>'date','today')<>'today' then raise exception 'invalid date'; end if;
 if day>(now() at time zone b.timezone)::date then op:='clarify'; end if;
 if p_command ? 'amount_cents' then amount:=(p_command->>'amount_cents')::bigint; end if;
 if op in ('sale','expense','receivable','payment','correct_last') and (amount is null or amount<1 or amount>100000000000) then raise exception 'invalid amount'; end if;
 if op in ('sale','expense','receivable','payment') then
  if op in ('receivable','payment') and (length(trim(coalesce(p_command->>'contact',''))) not between 1 and 120) then raise exception 'invalid contact'; end if;
  if op='receivable' then
   insert into contacts(business_id,name,name_key) values(p_business,trim(p_command->>'contact'),lower(trim(p_command->>'contact')))
   on conflict(business_id,name_key) do update set name=contacts.name returning id into contact;
  elsif op='payment' then
   select id into contact from contacts where business_id=p_business and name_key=lower(trim(p_command->>'contact'));
   select count(*), (array_agg(id))[1] into n,debt from accounts_receivable where business_id=p_business and contact_id=contact and balance_cents>0;
   if n<>1 then
    result:=jsonb_build_object('status','clarify','reason',case when n=0 then 'no_debt' else 'multiple_debts' end);
   else
    select balance_cents into bal from accounts_receivable where business_id=p_business and id=debt;
    if amount>bal then result:=jsonb_build_object('status','clarify','reason','overpayment','balance_cents',bal); end if;
   end if;
  end if;
  if result is null then
   insert into movements(business_id,actor_id,kind,amount_cents,description,occurred_on,contact_id,receivable_id,source_message_id)
   values(p_business,p_actor,op,amount,left(coalesce(p_command->>'description',''),240),day,contact,debt,msgid) returning * into m;
   insert into movement_audit(business_id,movement_id,actor_id,message_id,action,after_data) values(p_business,m.id,p_actor,msgid,'create',to_jsonb(m));
   result:=jsonb_build_object('status','recorded','kind',op,'amount_cents',amount,'movement_id',m.id,'date',day);
   if op='payment' then result:=result||jsonb_build_object('balance_cents',bal-amount); end if;
  end if;
 elsif op='totals' then
  first_day:=day; last_day:=day;
  if p_command->>'period'='week' then first_day:=date_trunc('week',day::timestamp)::date;
  elsif p_command->>'period'='month' then first_day:=date_trunc('month',day::timestamp)::date;
  elsif p_command->>'period'='all' then first_day:='0001-01-01';
  elsif coalesce(p_command->>'period','day')<>'day' then raise exception 'invalid period'; end if;
  select jsonb_build_object('status','totals','from',first_day,'to',last_day,
   'sales_cents',coalesce(sum(amount_cents) filter(where kind='sale'),0),
   'expenses_cents',coalesce(sum(amount_cents) filter(where kind='expense'),0),
   'payments_cents',coalesce(sum(amount_cents) filter(where kind='payment'),0)) into result
  from movements where business_id=p_business and voided_at is null and occurred_on between first_day and last_day;
 elsif op='balance' then
  select jsonb_build_object('status','balance','balance_cents',coalesce(sum(r.balance_cents),0)) into result
  from accounts_receivable r join contacts c on c.business_id=r.business_id and c.id=r.contact_id
  where r.business_id=p_business and ((p_command->>'contact') is null or c.name_key=lower(trim(p_command->>'contact')));
 elsif op in ('correct_last','delete_last') then
  select * into m from movements where business_id=p_business and actor_id=p_actor and voided_at is null order by sequence desc limit 1;
  if not found then result:=jsonb_build_object('status','clarify','reason','no_last');
  else
   update pending_actions set consumed_at=now() where business_id=p_business and actor_id=p_actor and channel=p_channel and consumed_at is null;
   insert into pending_actions(business_id,actor_id,channel,target_id,target_version,action,new_amount_cents,source_message_id)
   values(p_business,p_actor,p_channel,m.id,m.version,op,amount,msgid) returning * into pending;
   result:=jsonb_build_object('status','confirmation','action',op,'token',pending.token,'kind',m.kind,'description',m.description,'date',m.occurred_on,'old_amount_cents',m.amount_cents,'new_amount_cents',amount);
  end if;
 elsif op='confirm' then
  select * into pending from pending_actions where business_id=p_business and actor_id=p_actor and channel=p_channel
   and token=p_command->>'token' and consumed_at is null order by expires_at desc limit 1;
  if not found or pending.expires_at<now() then result:=jsonb_build_object('status','clarify','reason','expired');
  else
   update pending_actions set consumed_at=now() where id=pending.id;
   select * into m from movements where business_id=p_business and id=pending.target_id;
   if m.version<>pending.target_version or m.voided_at is not null then result:=jsonb_build_object('status','clarify','reason','changed');
   else
    before_m:=to_jsonb(m);
    if m.kind='receivable' then
     select coalesce(sum(amount_cents),0) into paid from movements where business_id=p_business and receivable_id=m.id and voided_at is null;
     if (pending.action='delete_last' and paid>0) or (pending.action='correct_last' and pending.new_amount_cents<paid) then
      result:=jsonb_build_object('status','clarify','reason','linked_payments');
     end if;
    elsif m.kind='payment' and pending.action='correct_last' then
     select balance_cents into bal from accounts_receivable where business_id=p_business and id=m.receivable_id;
     if pending.new_amount_cents>bal+m.amount_cents then result:=jsonb_build_object('status','clarify','reason','overpayment','balance_cents',bal+m.amount_cents); end if;
    end if;
    if result is null then
     update movements set amount_cents=case when pending.action='correct_last' then pending.new_amount_cents else amount_cents end,
      voided_at=case when pending.action='delete_last' then now() else null end, version=version+1,updated_at=now()
      where id=m.id returning * into m;
     insert into movement_audit(business_id,movement_id,actor_id,message_id,action,before_data,after_data)
      values(p_business,m.id,p_actor,msgid,pending.action,before_m,to_jsonb(m));
     result:=jsonb_build_object('status','changed','action',pending.action,'amount_cents',m.amount_cents,'movement_id',m.id);
    end if;
   end if;
  end if;
 elsif op='cancel' then
  update pending_actions set consumed_at=now() where business_id=p_business and actor_id=p_actor and channel=p_channel and consumed_at is null;
  result:=jsonb_build_object('status','cancelled');
 elsif op='clarify' then result:=jsonb_build_object('status','clarify','reason','ambiguous');
 else raise exception 'invalid intent';
 end if;
 result:=result||jsonb_build_object('message_id',msgid,'duplicate',false);
 update messages set response=result where id=msgid;
 return result;
end $$;
revoke all on function public.process_command(uuid,uuid,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.process_command(uuid,uuid,text,text,text,text,jsonb,jsonb) to service_role;

create function public.claim_delivery(p_message uuid) returns setof public.outbox language sql security definer set search_path=public as $$
 update outbox set status='sending',lease_until=now()+interval '90 seconds',attempts=attempts+1
 where message_id=p_message and (status='pending' or (status='sending' and lease_until<now())) returning *
$$;
revoke all on function public.claim_delivery(uuid) from public,anon,authenticated;
grant execute on function public.claim_delivery(uuid) to service_role;

create table public.request_limits(actor_id uuid primary key references public.profiles(id), window_start timestamptz not null, requests integer not null);
alter table public.request_limits enable row level security;
revoke all on public.request_limits from anon,authenticated;
grant all on public.request_limits to service_role;
create function public.consume_quota(p_actor uuid) returns boolean language plpgsql security definer set search_path=public as $$
declare used integer;
begin
 insert into request_limits(actor_id,window_start,requests) values(p_actor,date_trunc('minute',now()),1)
 on conflict(actor_id) do update set requests=case when request_limits.window_start=date_trunc('minute',now()) then request_limits.requests+1 else 1 end, window_start=date_trunc('minute',now())
 returning requests into used;
 return used<=30;
end $$;
revoke all on function public.consume_quota(uuid) from public,anon,authenticated;
grant execute on function public.consume_quota(uuid) to service_role;
