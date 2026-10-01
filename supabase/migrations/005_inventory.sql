-- Vendixa Sprint 5.7. Apply only to the confirmed Vendixa project after 004_pilot.sql.
-- Quantities are immutable signed events. Money is integer MXN cents.
begin;
create table public.products (
 id uuid primary key default gen_random_uuid(), business_id uuid not null references public.businesses(id),
 name text not null check(length(trim(name)) between 1 and 120),
 brand text, variant text, color text, size text, sku text,
 sale_price_cents bigint check(sale_price_cents between 1 and 100000000000),
 unit_cost_cents bigint check(unit_cost_cents between 1 and 100000000000),
 is_active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(business_id,id)
);
create unique index products_identity on public.products (
 business_id,lower(trim(name)),lower(trim(coalesce(brand,''))),lower(trim(coalesce(variant,''))),
 lower(trim(coalesce(color,''))),lower(trim(coalesce(size,''))),lower(trim(coalesce(sku,'')))
);
create unique index products_sku on public.products(business_id,lower(trim(sku))) where sku is not null;
create table public.inventory_movements (
 id uuid primary key default gen_random_uuid(), sequence bigint generated always as identity,
 business_id uuid not null, product_id uuid not null, actor_id uuid not null,
 kind text not null check(kind in ('opening_stock','stock_in','sale','adjustment_in','adjustment_out','reversal')),
 quantity_delta integer not null check(quantity_delta<>0 and abs(quantity_delta)<=1000000),
 occurred_on date not null, unit_price_cents bigint check(unit_price_cents between 1 and 100000000000),
 unit_cost_cents bigint check(unit_cost_cents between 1 and 100000000000),
 source_message_id uuid not null, financial_movement_id uuid,
 reverses_movement_id uuid unique, created_at timestamptz not null default now(),
 unique(business_id,id),
 foreign key(business_id,product_id) references public.products(business_id,id),
 foreign key(business_id,actor_id) references public.memberships(business_id,user_id),
 foreign key(business_id,source_message_id) references public.messages(business_id,id),
 foreign key(business_id,financial_movement_id) references public.movements(business_id,id),
 foreign key(business_id,reverses_movement_id) references public.inventory_movements(business_id,id),
 check((kind in ('opening_stock','stock_in','adjustment_in') and quantity_delta>0)
    or (kind in ('sale','adjustment_out') and quantity_delta<0) or kind='reversal'),
 check((kind='sale')=(financial_movement_id is not null))
);
create unique index inventory_sale_financial on public.inventory_movements(financial_movement_id) where financial_movement_id is not null;
create index inventory_movements_product on public.inventory_movements(business_id,product_id);
create table public.inventory_audit (
 id uuid primary key default gen_random_uuid(), business_id uuid not null,
 inventory_movement_id uuid not null, actor_id uuid not null, message_id uuid not null,
 action text not null check(action in ('create','reverse')),
 after_data jsonb not null, created_at timestamptz not null default now(),
 foreign key(business_id,inventory_movement_id) references public.inventory_movements(business_id,id),
 foreign key(business_id,actor_id) references public.memberships(business_id,user_id),
 foreign key(business_id,message_id) references public.messages(business_id,id)
);
create view public.inventory_stock with (security_invoker=true) as
 select p.business_id,p.id as product_id,p.name,p.brand,p.variant,p.color,p.size,p.sku,
  p.sale_price_cents,p.unit_cost_cents,p.is_active,
  coalesce(sum(i.quantity_delta),0)::bigint as quantity
 from public.products p left join public.inventory_movements i on i.business_id=p.business_id and i.product_id=p.id
 group by p.business_id,p.id;
create function public.inventory_product_label(p public.products) returns text language sql immutable as $$
 select concat_ws(' ',p.name,case when p.brand is not null then 'marca '||p.brand end,p.variant,p.color,
  case when p.size is not null then 'talla '||p.size end)
$$;
alter table public.products enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.inventory_audit enable row level security;
create policy member_products on public.products for select to authenticated using(public.is_member(business_id));
create policy member_inventory_movements on public.inventory_movements for select to authenticated using(public.is_member(business_id));
revoke all on public.products,public.inventory_movements,public.inventory_audit from anon,authenticated;
grant select on public.products,public.inventory_movements,public.inventory_stock to authenticated;
grant all on public.products,public.inventory_movements,public.inventory_audit to service_role;
grant usage,select on all sequences in schema public to service_role;

-- A confirmed deletion of a stock-linked sale restores stock in the same transaction.
create function public.reverse_inventory_sale() returns trigger language plpgsql security definer set search_path=public as $$
declare previous public.inventory_movements%rowtype; restored public.inventory_movements%rowtype; target public.movements%rowtype; b public.businesses%rowtype;
begin
 if new.action<>'delete_last' then return new; end if;
 select * into previous from public.inventory_movements where business_id=new.business_id and financial_movement_id=new.movement_id and kind='sale';
 if not found then return new; end if;
 select * into target from public.movements where business_id=new.business_id and id=new.movement_id;
 if target.voided_at is null then raise exception 'inventory reversal requires voided sale'; end if;
 select * into b from public.businesses where id=new.business_id;
 insert into public.inventory_movements(business_id,product_id,actor_id,kind,quantity_delta,occurred_on,unit_price_cents,unit_cost_cents,source_message_id,reverses_movement_id)
 values(new.business_id,previous.product_id,new.actor_id,'reversal',-previous.quantity_delta,(now() at time zone b.timezone)::date,
  previous.unit_price_cents,previous.unit_cost_cents,new.message_id,previous.id) returning * into restored;
 insert into public.inventory_audit(business_id,inventory_movement_id,actor_id,message_id,action,after_data)
 values(new.business_id,restored.id,new.actor_id,new.message_id,'reverse',to_jsonb(restored));
 return new;
end $$;
create trigger reverse_inventory_sale_after_audit after insert on public.movement_audit
 for each row execute function public.reverse_inventory_sale();

create function public.process_inventory_message(
 p_business uuid,p_actor uuid,p_channel text,p_external_id text,p_fingerprint text,p_content text,
 p_commands jsonb,p_media jsonb default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 b public.businesses%rowtype; oldmsg public.messages%rowtype; msgid uuid;
 p public.products%rowtype; m public.movements%rowtype; im public.inventory_movements%rowtype;
 entry jsonb; entries jsonb:='[]'::jsonb; result jsonb; products_json jsonb; intent text; reason text:='inventory_invalid';
 idx integer; n integer; qty integer; current_qty bigint; amount bigint; price bigint; cost bigint;
 day date; today date; label text; product_label text; available_qty bigint; total_qty bigint;
 sale_value numeric; cost_value numeric; unpriced_sale bigint; unpriced_cost bigint; more_products boolean;
begin
 select * into b from public.businesses where id=p_business for update;
 if not found or not b.is_active or not exists(select 1 from public.memberships where business_id=p_business and user_id=p_actor) then
  raise exception 'forbidden' using errcode='42501'; end if;
 if p_channel not in ('web','whatsapp') or length(p_external_id) not between 1 and 200 or length(p_content)>4000
  or jsonb_typeof(p_commands)<>'array' or jsonb_array_length(p_commands) not between 1 and 8 then raise exception 'invalid envelope'; end if;
 select * into oldmsg from public.messages where business_id=p_business and channel=p_channel and external_id=p_external_id;
 if found then
  if oldmsg.fingerprint<>p_fingerprint or oldmsg.actor_id<>p_actor then raise exception 'idempotency conflict' using errcode='23505'; end if;
  return oldmsg.response||jsonb_build_object('duplicate',true,'message_id',oldmsg.id);
 end if;
 insert into public.messages(business_id,actor_id,channel,external_id,fingerprint,content,interpretation,media)
 values(p_business,p_actor,p_channel,p_external_id,p_fingerprint,p_content,
  jsonb_build_object('intent','inventory','operations',p_commands),p_media) returning id into msgid;
 today:=(now() at time zone b.timezone)::date;
 if jsonb_array_length(p_commands)=1 and p_commands->0->>'intent' in ('inventory_list','inventory_count','inventory_value','inventory_top') then
  entry:=p_commands->0; intent:=entry->>'intent';
  if intent='inventory_count' and length(trim(coalesce(entry->>'product_name','')))=0 then raise exception 'invalid query'; end if;
  select coalesce(sum(s.quantity),0),
   coalesce(sum(s.quantity*s.sale_price_cents) filter(where s.sale_price_cents is not null),0),
   coalesce(sum(s.quantity*s.unit_cost_cents) filter(where s.unit_cost_cents is not null),0),
   coalesce(sum(s.quantity) filter(where s.sale_price_cents is null),0),
   coalesce(sum(s.quantity) filter(where s.unit_cost_cents is null),0),count(*)>20
  into total_qty,sale_value,cost_value,unpriced_sale,unpriced_cost,more_products
  from public.inventory_stock s where s.business_id=p_business and s.is_active and s.quantity>0
   and (intent<>'inventory_count' or (lower(s.name)=lower(entry->>'product_name')
    and (entry->>'brand' is null or lower(coalesce(s.brand,''))=lower(entry->>'brand'))
    and (entry->>'variant' is null or lower(coalesce(s.variant,''))=lower(entry->>'variant'))
    and (entry->>'color' is null or lower(coalesce(s.color,''))=lower(entry->>'color'))
    and (entry->>'size' is null or lower(coalesce(s.size,''))=lower(entry->>'size'))
    and (entry->>'sku' is null or lower(coalesce(s.sku,''))=lower(entry->>'sku'))));
  select coalesce(jsonb_agg(jsonb_build_object('label',x.label,'quantity',x.quantity,'id',x.id)
   order by x.quantity desc,x.label),'[]'::jsonb) into products_json from (
    select pr.id,public.inventory_product_label(pr) as label,s.quantity from public.inventory_stock s
    join public.products pr on pr.business_id=s.business_id and pr.id=s.product_id
    where s.business_id=p_business and s.is_active and s.quantity>0
     and (intent<>'inventory_count' or (lower(s.name)=lower(entry->>'product_name')
      and (entry->>'brand' is null or lower(coalesce(s.brand,''))=lower(entry->>'brand'))
      and (entry->>'variant' is null or lower(coalesce(s.variant,''))=lower(entry->>'variant'))
      and (entry->>'color' is null or lower(coalesce(s.color,''))=lower(entry->>'color'))
      and (entry->>'size' is null or lower(coalesce(s.size,''))=lower(entry->>'size'))
      and (entry->>'sku' is null or lower(coalesce(s.sku,''))=lower(entry->>'sku'))))
    order by s.quantity desc,public.inventory_product_label(pr) limit 20
   ) x;
  result:=jsonb_build_object('status',intent,'products',products_json,'total_quantity',total_qty,
   'label',entry->>'product_name','sale_value_cents',case when total_qty=unpriced_sale then null else sale_value::text end,
   'cost_value_cents',case when total_qty=unpriced_cost then null else cost_value::text end,
   'unpriced_sale_count',unpriced_sale,'unpriced_cost_count',unpriced_cost,'more',more_products);
 else
  begin
   for idx in 0..jsonb_array_length(p_commands)-1 loop
    entry:=p_commands->idx; intent:=entry->>'intent'; p:=null; m:=null; price:=null; cost:=null; amount:=null;
    if intent not in ('opening_stock','stock_in','inventory_sale','sale','expense') then raise sqlstate 'P2001'; end if;
    if coalesce(entry->>'date','today')='today' then day:=today;
    elsif entry->>'date'='yesterday' then day:=today-1;
    elsif entry->>'date' ~ '^\d{4}-\d{2}-\d{2}$' then day:=(entry->>'date')::date;
    else raise sqlstate 'P2001'; end if;
    if day>today then raise sqlstate 'P2001'; end if;
    if intent in ('sale','expense') then
     if coalesce(entry->>'amount_cents','') !~ '^[0-9]+$' then raise sqlstate 'P2001'; end if;
     amount:=(entry->>'amount_cents')::bigint;
     if amount not between 1 and 100000000000 then raise sqlstate 'P2001'; end if;
     insert into public.movements(business_id,actor_id,kind,amount_cents,description,occurred_on,source_message_id)
     values(p_business,p_actor,intent,amount,left(coalesce(entry->>'description',''),240),day,msgid) returning * into m;
     insert into public.movement_audit(business_id,movement_id,actor_id,message_id,action,after_data)
     values(p_business,m.id,p_actor,msgid,'create',to_jsonb(m));
     entries:=entries||jsonb_build_array(jsonb_build_object('kind',intent,'amount_cents',amount,'movement_id',m.id));
     continue;
    end if;
    if length(trim(coalesce(entry->>'product_name',''))) not between 1 and 120 or coalesce(entry->>'quantity','') !~ '^[0-9]+$' then raise sqlstate 'P2001'; end if;
    qty:=(entry->>'quantity')::integer;
    if qty not between 1 and 1000000 then raise sqlstate 'P2001'; end if;
    if entry ? 'unit_price_cents' then
     if entry->>'unit_price_cents' !~ '^[0-9]+$' then raise sqlstate 'P2001'; end if;
     price:=(entry->>'unit_price_cents')::bigint;
     if price not between 1 and 100000000000 then raise sqlstate 'P2001'; end if;
    end if;
    if entry ? 'unit_cost_cents' then
     if entry->>'unit_cost_cents' !~ '^[0-9]+$' then raise sqlstate 'P2001'; end if;
     cost:=(entry->>'unit_cost_cents')::bigint;
     if cost not between 1 and 100000000000 then raise sqlstate 'P2001'; end if;
    end if;
    if intent='opening_stock' then
     select * into p from public.products where business_id=p_business
      and lower(name)=lower(entry->>'product_name')
      and lower(coalesce(brand,''))=lower(coalesce(entry->>'brand',''))
      and lower(coalesce(variant,''))=lower(coalesce(entry->>'variant',''))
      and lower(coalesce(color,''))=lower(coalesce(entry->>'color',''))
      and lower(coalesce(size,''))=lower(coalesce(entry->>'size',''))
      and lower(coalesce(sku,''))=lower(coalesce(entry->>'sku',''));
     if found then reason:='inventory_exists';raise sqlstate 'P2001'; end if;
     insert into public.products(business_id,name,brand,variant,color,size,sku,sale_price_cents,unit_cost_cents)
     values(p_business,entry->>'product_name',entry->>'brand',entry->>'variant',entry->>'color',entry->>'size',entry->>'sku',price,cost)
     returning * into p;
     current_qty:=0;
    else
     select count(*),(array_agg(id))[1] into n,p.id from public.products where business_id=p_business and is_active
      and lower(name)=lower(entry->>'product_name')
      and (entry->>'brand' is null or lower(coalesce(brand,''))=lower(entry->>'brand'))
      and (entry->>'variant' is null or lower(coalesce(variant,''))=lower(entry->>'variant'))
      and (entry->>'color' is null or lower(coalesce(color,''))=lower(entry->>'color'))
      and (entry->>'size' is null or lower(coalesce(size,''))=lower(entry->>'size'))
      and (entry->>'sku' is null or lower(coalesce(sku,''))=lower(entry->>'sku'));
     if n<>1 then reason:=case when n=0 then 'inventory_missing' else 'inventory_ambiguous' end;raise sqlstate 'P2001'; end if;
     select * into p from public.products where business_id=p_business and id=p.id;
     select coalesce(sum(quantity_delta),0) into current_qty from public.inventory_movements where business_id=p_business and product_id=p.id;
    end if;
    product_label:=public.inventory_product_label(p);
    if intent='inventory_sale' then
     if current_qty<qty then reason:='stock_insufficient';available_qty:=current_qty;raise sqlstate 'P2001'; end if;
     if entry ? 'amount_cents' then
      if entry->>'amount_cents' !~ '^[0-9]+$' then raise sqlstate 'P2001'; end if;
      amount:=(entry->>'amount_cents')::bigint;
     else
      price:=coalesce(price,p.sale_price_cents);
      if price is null then raise sqlstate 'P2001'; end if;
      amount:=price*qty;
     end if;
     if amount not between 1 and 100000000000 then raise sqlstate 'P2001'; end if;
     insert into public.movements(business_id,actor_id,kind,amount_cents,description,occurred_on,source_message_id)
     values(p_business,p_actor,'sale',amount,product_label,day,msgid) returning * into m;
     insert into public.movement_audit(business_id,movement_id,actor_id,message_id,action,after_data)
     values(p_business,m.id,p_actor,msgid,'create',to_jsonb(m));
    end if;
    insert into public.inventory_movements(business_id,product_id,actor_id,kind,quantity_delta,occurred_on,unit_price_cents,unit_cost_cents,source_message_id,financial_movement_id)
    values(p_business,p.id,p_actor,case when intent='inventory_sale' then 'sale' else intent end,
     case when intent='inventory_sale' then -qty else qty end,day,
     case when intent='inventory_sale' then coalesce(price,case when amount%qty=0 then amount/qty end) else p.sale_price_cents end,
     p.unit_cost_cents,msgid,m.id) returning * into im;
    insert into public.inventory_audit(business_id,inventory_movement_id,actor_id,message_id,action,after_data)
    values(p_business,im.id,p_actor,msgid,'create',to_jsonb(im));
    entries:=entries||jsonb_build_array(jsonb_build_object('kind',intent,'product_id',p.id,'product_label',product_label,
     'quantity',qty,'stock_remaining',current_qty+im.quantity_delta,'inventory_movement_id',im.id,
     'movement_id',m.id,'amount_cents',amount));
   end loop;
   result:=jsonb_build_object('status',case when jsonb_array_length(p_commands)=1 then 'inventory_recorded' else 'inventory_batch_recorded' end,
    'operations',entries,'count',jsonb_array_length(entries));
  exception when sqlstate 'P2001' or unique_violation then
   result:=jsonb_build_object('status','clarify','reason',reason,'product_label',product_label,'available_quantity',available_qty);
  end;
 end if;
 result:=result||jsonb_build_object('message_id',msgid,'duplicate',false);
 update public.messages set response=result where id=msgid;
 return result;
end $$;
revoke all on function public.process_inventory_message(uuid,uuid,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.process_inventory_message(uuid,uuid,text,text,text,text,jsonb,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
