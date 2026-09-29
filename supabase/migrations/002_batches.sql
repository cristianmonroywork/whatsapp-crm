-- Cuenta Clara Sprint 4. Apply only to the confirmed isolated Cuenta Clara project, after 001_initial.sql.
-- A batch produces one message, one response, and one individually audited movement per operation.
create function public.process_batch(
 p_business uuid,p_actor uuid,p_channel text,p_external_id text,p_fingerprint text,p_content text,
 p_commands jsonb,p_media jsonb default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 b businesses%rowtype; oldmsg messages%rowtype; msgid uuid; m movements%rowtype;
 entry jsonb; entries jsonb:='[]'::jsonb; result jsonb; kind text; contact uuid; debt uuid;
 amount bigint; balance bigint; day date; today date; date_text text; failure text:='ambiguous';
 idx integer; ref integer; n integer; used_refs integer[]:='{}'; paid_now bigint; sale_amount bigint;
begin
 select * into b from businesses where id=p_business for update;
 if not found or not exists(select 1 from memberships where business_id=p_business and user_id=p_actor) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_channel not in ('web','whatsapp') or length(p_external_id) not between 1 and 200 or length(p_content)>4000 then raise exception 'invalid envelope'; end if;
 if jsonb_typeof(p_commands)<>'array' or jsonb_array_length(p_commands) not between 2 and 8 then raise exception 'invalid batch'; end if;
 select * into oldmsg from messages where business_id=p_business and channel=p_channel and external_id=p_external_id;
 if found then
  if oldmsg.fingerprint<>p_fingerprint or oldmsg.actor_id<>p_actor then raise exception 'idempotency conflict' using errcode='23505'; end if;
  return oldmsg.response||jsonb_build_object('duplicate',true,'message_id',oldmsg.id);
 end if;
 insert into messages(business_id,actor_id,channel,external_id,fingerprint,content,interpretation,media)
 values(p_business,p_actor,p_channel,p_external_id,p_fingerprint,p_content,jsonb_build_object('intent','batch','operations',p_commands),p_media)
 returning id into msgid;
 today:=(now() at time zone b.timezone)::date;
 begin
  for idx in 0..jsonb_array_length(p_commands)-1 loop
   entry:=p_commands->idx;kind:=entry->>'intent';contact:=null;debt:=null;balance:=null;
   if kind not in ('sale','expense','receivable','payment') or coalesce(entry->>'amount_cents','') !~ '^[0-9]+$' then failure:='invalid_operation';raise sqlstate 'P2001'; end if;
   amount:=(entry->>'amount_cents')::bigint;
   if amount not between 1 and 100000000000 or length(coalesce(entry->>'description',''))>240 then failure:='invalid_operation';raise sqlstate 'P2001'; end if;
   date_text:=coalesce(entry->>'date','today');
   if date_text='today' then day:=today;
   elsif date_text='yesterday' then day:=today-1;
   elsif date_text ~ '^\d{4}-\d{2}-\d{2}$' then day:=date_text::date;
   else failure:='invalid_date';raise sqlstate 'P2001'; end if;
   if day>today then failure:='future_date';raise sqlstate 'P2001'; end if;
   if kind in ('receivable','payment') then
    if length(trim(coalesce(entry->>'contact',''))) not between 1 and 120 then failure:='invalid_contact';raise sqlstate 'P2001'; end if;
   end if;
   if kind='sale' and entry ? 'upfront_paid_cents' then
    paid_now:=(entry->>'upfront_paid_cents')::bigint;
    if paid_now<0 or paid_now>=amount then failure:='invalid_credit';raise sqlstate 'P2001'; end if;
   end if;
   if kind='receivable' and entry ? 'sale_ref' then
    ref:=(entry->>'sale_ref')::integer;
    if ref<0 or ref>=idx or ref=any(used_refs) or p_commands->ref->>'intent'<>'sale' then failure:='invalid_credit';raise sqlstate 'P2001'; end if;
    sale_amount:=(p_commands->ref->>'amount_cents')::bigint;
    paid_now:=coalesce((p_commands->ref->>'upfront_paid_cents')::bigint,0);
    if amount+paid_now<>sale_amount then failure:='invalid_credit';raise sqlstate 'P2001'; end if;
    used_refs:=array_append(used_refs,ref);
   end if;
   if kind='receivable' then
    insert into contacts(business_id,name,name_key) values(p_business,trim(entry->>'contact'),lower(trim(entry->>'contact')))
    on conflict(business_id,name_key) do update set name=contacts.name returning id into contact;
   elsif kind='payment' then
    select id into contact from contacts where business_id=p_business and name_key=lower(trim(entry->>'contact'));
    select count(*),(array_agg(id))[1] into n,debt from accounts_receivable where business_id=p_business and contact_id=contact and balance_cents>0;
    if n<>1 then failure:=case when n=0 then 'no_debt' else 'multiple_debts' end;raise sqlstate 'P2001'; end if;
    select balance_cents into balance from accounts_receivable where business_id=p_business and id=debt;
    if amount>balance then failure:='overpayment';raise sqlstate 'P2001'; end if;
   end if;
   insert into movements(business_id,actor_id,kind,amount_cents,description,occurred_on,contact_id,receivable_id,source_message_id)
   values(p_business,p_actor,kind,amount,coalesce(entry->>'description',''),day,contact,debt,msgid) returning * into m;
   insert into movement_audit(business_id,movement_id,actor_id,message_id,action,after_data)
   values(p_business,m.id,p_actor,msgid,'create',to_jsonb(m));
   entries:=entries||jsonb_build_array(jsonb_build_object('kind',kind,'amount_cents',amount,'movement_id',m.id,'date',day,'contact',entry->>'contact'));
  end loop;
  for idx in 0..jsonb_array_length(p_commands)-1 loop
   entry:=p_commands->idx;
   if entry->>'intent'='sale' and entry ? 'upfront_paid_cents' and not idx=any(used_refs) then failure:='invalid_credit';raise sqlstate 'P2001'; end if;
  end loop;
  result:=jsonb_build_object('status','batch_recorded','operations',entries,'count',jsonb_array_length(entries));
 exception when sqlstate 'P2001' then
  result:=jsonb_build_object('status','clarify','reason','batch_invalid','detail',failure);
 end;
 result:=result||jsonb_build_object('message_id',msgid,'duplicate',false);
 update messages set response=result where id=msgid;
 return result;
end $$;
revoke all on function public.process_batch(uuid,uuid,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.process_batch(uuid,uuid,text,text,text,text,jsonb,jsonb) to service_role;

-- A generic "correct/delete the last one" after a multi-operation message has no safe target.
-- Keep the original single-movement behavior, but guard its entry point under the same business lock.
alter function public.process_command(uuid,uuid,text,text,text,text,jsonb,jsonb) rename to process_command_legacy;
revoke all on function public.process_command_legacy(uuid,uuid,text,text,text,text,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.process_command(
 p_business uuid,p_actor uuid,p_channel text,p_external_id text,p_fingerprint text,p_content text,
 p_command jsonb,p_media jsonb default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare last_source uuid; same_source integer; result jsonb;
begin
 if p_command->>'intent' in ('correct_last','delete_last') then
  perform 1 from businesses where id=p_business for update;
  if not found or not exists(select 1 from memberships where business_id=p_business and user_id=p_actor) then raise exception 'forbidden' using errcode='42501'; end if;
  select source_message_id into last_source from movements where business_id=p_business and actor_id=p_actor and voided_at is null order by sequence desc limit 1;
  if last_source is not null then
   select count(*) into same_source from movements where business_id=p_business and source_message_id=last_source;
   if same_source>1 then
    result:=public.process_command_legacy(p_business,p_actor,p_channel,p_external_id,p_fingerprint,p_content,jsonb_build_object('intent','clarify'),p_media);
    result:=result||jsonb_build_object('reason','batch_target');
    update messages set interpretation=jsonb_build_object('intent','clarify','reason','batch_target'),response=result where id=(result->>'message_id')::uuid;
    return result;
   end if;
  end if;
 end if;
 return public.process_command_legacy(p_business,p_actor,p_channel,p_external_id,p_fingerprint,p_content,p_command,p_media);
end $$;
revoke all on function public.process_command(uuid,uuid,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.process_command(uuid,uuid,text,text,text,text,jsonb,jsonb) to service_role;
notify pgrst, 'reload schema';
