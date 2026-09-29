-- Sprint 5.5: isolated pilot onboarding, observability, and reversible deactivation.
alter table public.businesses add column if not exists is_pilot boolean not null default false;
alter table public.businesses add column if not exists is_active boolean not null default true;

create table if not exists public.pilot_operators (
 user_id uuid primary key references public.profiles(id), created_at timestamptz not null default now()
);
create table if not exists public.pilot_events (
 id uuid primary key default gen_random_uuid(), business_id uuid references public.businesses(id),
 user_id uuid references public.profiles(id), event_type text not null,
 source_message_id uuid references public.messages(id), movement_id uuid references public.movements(id), error_code text,
 created_at timestamptz not null default now(),
 unique(movement_id,event_type)
);
create index if not exists pilot_events_business_time on public.pilot_events(business_id,created_at desc);
create unique index if not exists pilot_events_message_type on public.pilot_events(source_message_id,event_type) where movement_id is null and source_message_id is not null;
create table if not exists public.pilot_presence (
 business_id uuid not null references public.businesses(id), user_id uuid not null references public.profiles(id),
 last_seen_at timestamptz not null default now(), primary key(business_id,user_id)
);
create table if not exists public.pilot_daily_limits (
 business_id uuid not null references public.businesses(id), user_id uuid not null references public.profiles(id),
 local_day date not null, requests integer not null default 0, primary key(business_id,user_id,local_day)
);
create or replace function public.pilot_presence_event() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='INSERT' or old.last_seen_at<now()-interval '15 minutes' then
  insert into public.pilot_events(business_id,user_id,event_type) values(new.business_id,new.user_id,'session_started');
 end if;
 return new;
end $$;
drop trigger if exists pilot_presence_event_trigger on public.pilot_presence;
create trigger pilot_presence_event_trigger after insert or update on public.pilot_presence for each row execute function public.pilot_presence_event();
alter table public.pilot_operators enable row level security;
alter table public.pilot_events enable row level security;
alter table public.pilot_presence enable row level security;
alter table public.pilot_daily_limits enable row level security;
revoke all on public.pilot_operators,public.pilot_events,public.pilot_presence,public.pilot_daily_limits from anon,authenticated;
grant all on public.pilot_operators,public.pilot_events,public.pilot_presence,public.pilot_daily_limits to service_role;

create or replace function public.is_member(bid uuid) returns boolean language sql stable security definer set search_path=public as $$
 select exists(select 1 from public.memberships m join public.businesses b on b.id=m.business_id
  where m.business_id=bid and m.user_id=auth.uid() and b.is_active)
$$;

create or replace function public.create_pilot_business(p_actor uuid,p_name text,p_timezone text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.businesses%rowtype;
begin
 if not exists(select 1 from auth.users where id=p_actor) then raise exception 'unauthorized' using errcode='42501'; end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 120 then raise exception 'invalid name'; end if;
 if not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'invalid timezone'; end if;
 insert into public.profiles(id) values(p_actor) on conflict(id) do nothing;
 perform 1 from public.profiles where id=p_actor for update;
 if exists(select 1 from public.memberships m join public.businesses x on x.id=m.business_id where m.user_id=p_actor and x.is_pilot and x.is_active) then
  raise exception 'pilot business already exists' using errcode='23505';
 end if;
 insert into public.businesses(name,timezone,is_pilot) values(trim(p_name),p_timezone,true) returning * into b;
 insert into public.memberships(business_id,user_id,role) values(b.id,p_actor,'owner');
 insert into public.pilot_events(business_id,user_id,event_type) values(b.id,p_actor,'business_created');
 insert into public.pilot_events(business_id,user_id,event_type) values(b.id,p_actor,'signup_completed');
 return jsonb_build_object('id',b.id,'name',b.name,'timezone',b.timezone,'is_pilot',true);
end $$;
revoke all on function public.create_pilot_business(uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_pilot_business(uuid,text,text) to service_role;

create or replace function public.consume_pilot_quota(p_actor uuid,p_business uuid,p_minute_limit integer,p_daily_limit integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare b public.businesses%rowtype; minute_used integer; daily_used integer;
begin
 select * into b from public.businesses where id=p_business;
 if not found or not b.is_active or not exists(select 1 from public.memberships where business_id=p_business and user_id=p_actor) then return false; end if;
 if p_minute_limit not between 1 and 1000 or p_daily_limit not between 1 and 10000 then raise exception 'invalid limit'; end if;
 insert into public.request_limits(actor_id,window_start,requests) values(p_actor,date_trunc('minute',now()),1)
 on conflict(actor_id) do update set requests=case when request_limits.window_start=date_trunc('minute',now()) then request_limits.requests+1 else 1 end,
 window_start=date_trunc('minute',now()) returning requests into minute_used;
 if minute_used>p_minute_limit then return false; end if;
 insert into public.pilot_daily_limits(business_id,user_id,local_day,requests)
 values(p_business,p_actor,(now() at time zone b.timezone)::date,1)
 on conflict(business_id,user_id,local_day) do update set requests=pilot_daily_limits.requests+1 returning requests into daily_used;
 return daily_used<=p_daily_limit;
end $$;
revoke all on function public.consume_pilot_quota(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.consume_pilot_quota(uuid,uuid,integer,integer) to service_role;

create or replace function public.pilot_message_event() returns trigger language plpgsql security definer set search_path=public as $$
declare intent text;
begin
 if new.response is null then return new; end if;
 if tg_op='UPDATE' and old.response is not null then return new; end if;
 if not exists(select 1 from public.businesses where id=new.business_id and is_pilot) then return new; end if;
 insert into public.pilot_events(business_id,user_id,event_type,source_message_id)
 values(new.business_id,new.actor_id,case when new.media->>'type'='audio' then 'message_audio_sent' else 'message_text_sent' end,new.id)
 on conflict do nothing;
 intent:=new.interpretation->>'intent';
 if intent in ('totals','balance','debtors','summary','comparison','best_day','business_overview') then
  insert into public.pilot_events(business_id,user_id,event_type,source_message_id) values(new.business_id,new.actor_id,'query_executed',new.id) on conflict do nothing;
 end if;
 if new.response->>'status'='clarify' then
  insert into public.pilot_events(business_id,user_id,event_type,source_message_id) values(new.business_id,new.actor_id,'ambiguity_returned',new.id) on conflict do nothing;
 elsif new.response->>'status'='confirmation' then
  insert into public.pilot_events(business_id,user_id,event_type,source_message_id) values(new.business_id,new.actor_id,'correction_requested',new.id) on conflict do nothing;
 end if;
 return new;
end $$;
drop trigger if exists pilot_message_event_trigger on public.messages;
create trigger pilot_message_event_trigger after insert or update of response on public.messages for each row execute function public.pilot_message_event();

create or replace function public.pilot_movement_event() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if exists(select 1 from public.businesses where id=new.business_id and is_pilot) then
  insert into public.pilot_events(business_id,user_id,event_type,source_message_id,movement_id)
  values(new.business_id,new.actor_id,case new.action when 'delete_last' then 'deletion_confirmed' when 'correct_last' then 'correction_confirmed' else 'transaction_created' end,new.message_id,new.movement_id)
  on conflict do nothing;
 end if;
 return new;
end $$;
drop trigger if exists pilot_movement_event_trigger on public.movement_audit;
create trigger pilot_movement_event_trigger after insert on public.movement_audit for each row execute function public.pilot_movement_event();

create or replace function public.block_inactive_pilot_message() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.businesses where id=new.business_id and is_active) then raise exception 'business inactive' using errcode='42501'; end if;
 return new;
end $$;
drop trigger if exists block_inactive_pilot_message_trigger on public.messages;
create trigger block_inactive_pilot_message_trigger before insert on public.messages for each row execute function public.block_inactive_pilot_message();

create or replace function public.deactivate_pilot_business(p_actor uuid,p_business uuid,p_expected_name text,p_phrase text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare b public.businesses%rowtype;
begin
 if not exists(select 1 from public.pilot_operators where user_id=p_actor) then raise exception 'forbidden' using errcode='42501'; end if;
 select * into b from public.businesses where id=p_business for update;
 if not found or not b.is_pilot or not b.is_active or b.name<>p_expected_name or p_phrase<>'DESACTIVAR PILOTO' then
  raise exception 'confirmation mismatch' using errcode='22023';
 end if;
 update public.businesses set is_active=false where id=b.id;
 insert into public.pilot_events(business_id,user_id,event_type) values(b.id,p_actor,'pilot_deactivated');
 return jsonb_build_object('id',b.id,'is_active',false);
end $$;
revoke all on function public.deactivate_pilot_business(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.deactivate_pilot_business(uuid,uuid,text,text) to service_role;

create or replace function public.pilot_dashboard(p_actor uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.pilot_operators where user_id=p_actor) then raise exception 'forbidden' using errcode='42501'; end if;
 select coalesce(jsonb_agg(row_data order by row_data->>'created_at' desc),'[]'::jsonb) into result from (
  select jsonb_build_object('id',b.id,'name',b.name,'is_active',b.is_active,'created_at',b.created_at,
   'users',coalesce((select jsonb_agg(jsonb_build_object('id',m.user_id,'name',p.display_name,'email',u.email))
      from public.memberships m join public.profiles p on p.id=m.user_id join auth.users u on u.id=m.user_id where m.business_id=b.id),'[]'::jsonb),
   'last_access',(select max(last_seen_at) from public.pilot_presence where business_id=b.id),
   'active_sessions',(select count(*) from public.pilot_presence where business_id=b.id and last_seen_at>now()-interval '15 minutes'),
   'messages',(select count(*) from public.pilot_events where business_id=b.id and event_type in ('message_text_sent','message_audio_sent')),
   'operations',(select count(*) from public.pilot_events where business_id=b.id and event_type='transaction_created'),
   'queries',(select count(*) from public.pilot_events where business_id=b.id and event_type='query_executed'),
   'voice',(select count(*) from public.pilot_events where business_id=b.id and event_type='message_audio_sent'),
   'errors',(select count(*) from public.pilot_events where business_id=b.id and event_type='error_returned'),
   'ambiguous',(select count(*) from public.pilot_events where business_id=b.id and event_type='ambiguity_returned'),
   'corrections',(select count(*) from public.pilot_events where business_id=b.id and event_type='correction_confirmed'),
   'deletions',(select count(*) from public.pilot_events where business_id=b.id and event_type='deletion_confirmed'),
   'first_use',(select min(created_at) from public.pilot_events where business_id=b.id and event_type in ('message_text_sent','message_audio_sent')),
   'last_use',(select max(created_at) from public.pilot_events where business_id=b.id and event_type in ('message_text_sent','message_audio_sent'))
  ) row_data from public.businesses b where b.is_pilot
 ) rows;
 return result;
end $$;
revoke all on function public.pilot_dashboard(uuid) from public,anon,authenticated;
grant execute on function public.pilot_dashboard(uuid) to service_role;
notify pgrst, 'reload schema';
