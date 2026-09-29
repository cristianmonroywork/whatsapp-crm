-- Cuenta Clara Sprint 5. Apply after 002_batches.sql to the confirmed isolated project.
-- Read-only financial calculations are scoped to one authorized business and one DB snapshot.
create or replace function public.process_financial_query(
 p_business uuid,p_actor uuid,p_channel text,p_external_id text,p_fingerprint text,p_content text,
 p_command jsonb,p_media jsonb default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 b businesses%rowtype; oldmsg messages%rowtype; msgid uuid; result jsonb;
 today date; first_day date; last_day date; previous_first date; previous_last date;
 period text:=p_command->>'period'; intent text:=p_command->>'intent'; metric text:=p_command->>'metric';
 sales bigint; expenses bigint; payments bigint; movement_count integer; previous_sales bigint;
 total_balance bigint; days jsonb; debtors jsonb; day date;
begin
 select * into b from businesses where id=p_business for update;
 if not found or not exists(select 1 from memberships where business_id=p_business and user_id=p_actor) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_channel not in ('web','whatsapp') or length(p_external_id) not between 1 and 200 or length(p_content)>4000 then raise exception 'invalid envelope'; end if;
 if intent not in ('totals','balance','debtors','summary','comparison','best_day','business_overview') then raise exception 'invalid query intent'; end if;
 select * into oldmsg from messages where business_id=p_business and channel=p_channel and external_id=p_external_id;
 if found then
  if oldmsg.fingerprint<>p_fingerprint or oldmsg.actor_id<>p_actor then raise exception 'idempotency conflict' using errcode='23505'; end if;
  return oldmsg.response||jsonb_build_object('duplicate',true,'message_id',oldmsg.id);
 end if;
 today:=(now() at time zone b.timezone)::date;
 day:=today;
 if p_command->>'date'='yesterday' then day:=today-1;
 elsif p_command->>'date' ~ '^\d{4}-\d{2}-\d{2}$' then day:=(p_command->>'date')::date;
 elsif coalesce(p_command->>'date','today')<>'today' then raise exception 'invalid query date'; end if;
 if period='day' then first_day:=day;last_day:=day;
 elsif period='week' then first_day:=date_trunc('week',day::timestamp)::date;last_day:=first_day+6;
 elsif period='last_week' then first_day:=date_trunc('week',today::timestamp)::date-7;last_day:=first_day+6;
 elsif period='month' then first_day:=date_trunc('month',day::timestamp)::date;last_day:=(first_day+interval '1 month')::date-1;
 elsif period='last_month' then first_day:=(date_trunc('month',today::timestamp)-interval '1 month')::date;last_day:=date_trunc('month',today::timestamp)::date-1;
 elsif period='range' then first_day:=(p_command->>'from_date')::date;last_day:=(p_command->>'to_date')::date;
 elsif period='all' then first_day:='2000-01-01';last_day:=today;
 else raise exception 'invalid query period'; end if;
 if first_day is null or last_day is null or first_day>last_day or first_day>today or last_day>today+31
  or (period in ('day','range') and last_day>today) or (period='range' and last_day-first_day>3660) then
  result:=jsonb_build_object('status','clarify','reason','invalid_period');
 else
  if period='week' or period='last_week' then previous_first:=first_day-7;previous_last:=first_day-1;
  elsif period='month' or period='last_month' then previous_first:=(first_day-interval '1 month')::date;previous_last:=first_day-1;
  elsif period='all' then previous_first:=null;previous_last:=null;
  else previous_last:=first_day-1;previous_first:=previous_last-(last_day-first_day); end if;
  select coalesce(sum(amount_cents) filter(where kind='sale'),0),
   coalesce(sum(amount_cents) filter(where kind='expense'),0),
   coalesce(sum(amount_cents) filter(where kind='payment'),0),count(*)::integer
  into sales,expenses,payments,movement_count
  from movements where business_id=p_business and voided_at is null and occurred_on between first_day and last_day;
  select coalesce(sum(amount_cents),0) into previous_sales from movements
   where business_id=p_business and voided_at is null and kind='sale' and occurred_on between previous_first and previous_last;
  select coalesce(jsonb_agg(jsonb_build_object('date',occurred_on,'sales_cents',sales_cents::text) order by occurred_on),'[]'::jsonb) into days
   from (select occurred_on,sum(amount_cents) as sales_cents from movements
    where business_id=p_business and voided_at is null and kind='sale' and occurred_on between first_day and last_day
    group by occurred_on) daily;
  select coalesce(sum(r.balance_cents),0) into total_balance from accounts_receivable r
   join contacts c on c.business_id=r.business_id and c.id=r.contact_id
   where r.business_id=p_business and r.balance_cents>0 and
    (p_command->>'contact' is null or c.name_key=lower(trim(p_command->>'contact')));
  select coalesce(jsonb_agg(jsonb_build_object('contact',name,'balance_cents',balance_cents::text) order by lower(name)),'[]'::jsonb) into debtors
   from (select c.name,sum(r.balance_cents) as balance_cents from accounts_receivable r
    join contacts c on c.business_id=r.business_id and c.id=r.contact_id
    where r.business_id=p_business and r.balance_cents>0 and
     (p_command->>'contact' is null or c.name_key=lower(trim(p_command->>'contact')))
    group by c.id,c.name) open_debts;
  result:=jsonb_build_object('status',intent,'metric',metric,'period',period,'from',first_day,'to',last_day,
   'previous_from',previous_first,'previous_to',previous_last,
   'sales_cents',sales::text,'expenses_cents',expenses::text,'payments_cents',payments::text,'movement_count',movement_count,
   'previous_sales_cents',previous_sales::text,'balance_cents',total_balance::text,'days',days,'debtors',debtors);
 end if;
 insert into messages(business_id,actor_id,channel,external_id,fingerprint,content,interpretation,media,response)
 values(p_business,p_actor,p_channel,p_external_id,p_fingerprint,p_content,p_command,p_media,result)
 returning id into msgid;
 return result||jsonb_build_object('message_id',msgid,'duplicate',false);
end $$;
revoke all on function public.process_financial_query(uuid,uuid,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.process_financial_query(uuid,uuid,text,text,text,text,jsonb,jsonb) to service_role;
notify pgrst, 'reload schema';
