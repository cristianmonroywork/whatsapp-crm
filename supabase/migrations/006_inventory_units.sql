-- Vendixa 5.7.1. Apply once, after 005_inventory.sql, only to the confirmed Vendixa project.
-- Quantities and conversion factors are exact NUMERIC values; currency remains integer cents.
begin;

drop view public.inventory_stock;
alter table public.inventory_movements alter column quantity_delta type numeric(18,6) using quantity_delta::numeric(18,6);
alter table public.inventory_movements drop constraint if exists inventory_movements_quantity_delta_check;
alter table public.inventory_movements add constraint inventory_quantity_delta_bounded
 check(quantity_delta<>0 and abs(quantity_delta)<=100000000000);
alter table public.products add column base_unit text not null default 'pieza'
 check(base_unit in ('pieza','kg','litro','caja','paquete','costal'));
alter table public.products add column sale_price_base_cents numeric(24,6);
alter table public.products add column cost_price_base_cents numeric(24,6);
alter table public.products add column sale_price_original_cents bigint;
alter table public.products add column sale_price_unit text;
alter table public.products add column cost_original_cents bigint;
alter table public.products add column cost_unit text;
update public.products set sale_price_base_cents=sale_price_cents,cost_price_base_cents=unit_cost_cents,
 sale_price_original_cents=sale_price_cents,sale_price_unit=case when sale_price_cents is not null then 'pieza' end,
 cost_original_cents=unit_cost_cents,cost_unit=case when unit_cost_cents is not null then 'pieza' end;
alter table public.products add constraint sale_price_base_positive check(sale_price_base_cents>0 and sale_price_base_cents<=100000000000);
alter table public.products add constraint cost_price_base_positive check(cost_price_base_cents>0 and cost_price_base_cents<=100000000000);

alter table public.inventory_movements add column original_quantity numeric(18,6);
alter table public.inventory_movements add column original_unit text;
alter table public.inventory_movements add column base_unit text;
alter table public.inventory_movements add column original_price_cents bigint;
alter table public.inventory_movements add column original_price_unit text;
alter table public.inventory_movements add column original_sale_price_cents bigint;
alter table public.inventory_movements add column original_sale_price_unit text;
alter table public.inventory_movements add column original_cost_cents bigint;
alter table public.inventory_movements add column original_cost_unit text;
alter table public.inventory_movements add column effective_price_base_cents numeric(24,6);
alter table public.inventory_movements add column calculated_amount_cents bigint;
update public.inventory_movements im set
 original_quantity=abs(im.quantity_delta),original_unit='pieza',base_unit='pieza',
 original_price_cents=im.unit_price_cents,original_price_unit=case when im.unit_price_cents is null then null else 'pieza' end,
 original_sale_price_cents=im.unit_price_cents,original_sale_price_unit=case when im.unit_price_cents is null then null else 'pieza' end,
 original_cost_cents=case when im.kind in ('opening_stock','stock_in') then im.unit_cost_cents end,
 original_cost_unit=case when im.kind in ('opening_stock','stock_in') and im.unit_cost_cents is not null then 'pieza' end,
 effective_price_base_cents=im.unit_price_cents,
 calculated_amount_cents=(select m.amount_cents from public.movements m where m.id=im.financial_movement_id);
alter table public.inventory_movements alter column original_quantity set not null;
alter table public.inventory_movements alter column original_unit set not null;
alter table public.inventory_movements alter column base_unit set not null;
alter table public.inventory_movements add constraint inventory_original_quantity_positive check(original_quantity>0);

create view public.inventory_stock with (security_invoker=true) as
 select p.business_id,p.id as product_id,p.name,p.brand,p.variant,p.color,p.size,p.sku,
  p.sale_price_cents,p.unit_cost_cents,p.sale_price_base_cents,p.cost_price_base_cents,
  p.sale_price_original_cents,p.sale_price_unit,p.cost_original_cents,p.cost_unit,p.base_unit,p.is_active,
  coalesce(sum(i.quantity_delta),0)::numeric(18,6) as quantity
 from public.products p left join public.inventory_movements i on i.business_id=p.business_id and i.product_id=p.id
 group by p.business_id,p.id;
grant select on public.inventory_stock to authenticated,service_role;

create function public.inventory_unit_factor(p_from text,p_to text) returns numeric language sql immutable as $$
 select case
  when p_from=p_to then 1::numeric
  when p_from='g' and p_to='kg' then 0.001::numeric
  when p_from='kg' and p_to='g' then 1000::numeric
  when p_from='tonelada' and p_to='kg' then 1000::numeric
  when p_from='kg' and p_to='tonelada' then 0.001::numeric
  when p_from='g' and p_to='tonelada' then 0.000001::numeric
  when p_from='tonelada' and p_to='g' then 1000000::numeric
  when p_from='ml' and p_to='litro' then 0.001::numeric
  when p_from='litro' and p_to='ml' then 1000::numeric
  when p_from='docena' and p_to='pieza' then 12::numeric
  when p_from='pieza' and p_to='docena' then (1::numeric/12)
 end
$$;
revoke all on function public.inventory_unit_factor(text,text) from public,anon,authenticated;
grant execute on function public.inventory_unit_factor(text,text) to service_role;
create function public.inventory_convert_quantity(p_quantity numeric,p_from text,p_to text) returns numeric language sql immutable as $$
 select case when p_from='pieza' and p_to='docena' then p_quantity/12
  else p_quantity*public.inventory_unit_factor(p_from,p_to) end
$$;
revoke all on function public.inventory_convert_quantity(numeric,text,text) from public,anon,authenticated;
grant execute on function public.inventory_convert_quantity(numeric,text,text) to service_role;

create or replace function public.reverse_inventory_sale() returns trigger language plpgsql security definer set search_path=public as $$
declare previous public.inventory_movements%rowtype; restored public.inventory_movements%rowtype; target public.movements%rowtype; b public.businesses%rowtype;
begin
 if new.action<>'delete_last' then return new; end if;
 select * into previous from public.inventory_movements where business_id=new.business_id and financial_movement_id=new.movement_id and kind='sale';
 if not found then return new; end if;
 select * into target from public.movements where business_id=new.business_id and id=new.movement_id;
 if target.voided_at is null then raise exception 'inventory reversal requires voided sale'; end if;
 select * into b from public.businesses where id=new.business_id;
 insert into public.inventory_movements(business_id,product_id,actor_id,kind,quantity_delta,occurred_on,unit_price_cents,unit_cost_cents,
  source_message_id,reverses_movement_id,original_quantity,original_unit,base_unit,original_price_cents,original_price_unit,
  original_sale_price_cents,original_sale_price_unit,original_cost_cents,original_cost_unit,
  effective_price_base_cents,calculated_amount_cents)
 values(new.business_id,previous.product_id,new.actor_id,'reversal',-previous.quantity_delta,(now() at time zone b.timezone)::date,
  previous.unit_price_cents,previous.unit_cost_cents,new.message_id,previous.id,previous.original_quantity,previous.original_unit,
  previous.base_unit,previous.original_price_cents,previous.original_price_unit,
  previous.original_sale_price_cents,previous.original_sale_price_unit,previous.original_cost_cents,previous.original_cost_unit,
  previous.effective_price_base_cents,
  previous.calculated_amount_cents) returning * into restored;
 insert into public.inventory_audit(business_id,inventory_movement_id,actor_id,message_id,action,after_data)
 values(new.business_id,restored.id,new.actor_id,new.message_id,'reverse',to_jsonb(restored));
 return new;
end $$;

-- The business row serializes concurrent stock changes. The inner block rolls back every
-- financial and inventory mutation while retaining one idempotent clarification receipt.
create or replace function public.process_inventory_message(
 p_business uuid,p_actor uuid,p_channel text,p_external_id text,p_fingerprint text,p_content text,
 p_commands jsonb,p_media jsonb default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 b public.businesses%rowtype; oldmsg public.messages%rowtype; msgid uuid;
 p public.products%rowtype; m public.movements%rowtype; im public.inventory_movements%rowtype;
 entry jsonb; entries jsonb:='[]'::jsonb; result jsonb; products_json jsonb; intent text; reason text:='inventory_invalid';
 idx integer; n integer; qty numeric(18,6); base_qty numeric(18,6); factor numeric; current_qty numeric(18,6);
 amount bigint; price bigint; cost bigint; price_base numeric(24,6); cost_base numeric(24,6);
 input_unit text; price_unit text; v_cost_unit text; wanted_unit text; chosen_unit text;
 day date; today date; product_label text; available_qty numeric(18,6); total_qty numeric(18,6);
 sale_value numeric; cost_value numeric; unpriced_sale numeric; unpriced_cost numeric; more_products boolean;
 unit_count integer; product_count integer;
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
  entry:=p_commands->0; intent:=entry->>'intent'; wanted_unit:=entry->>'unit';
  if wanted_unit is not null and wanted_unit not in ('pieza','kg','g','tonelada','litro','ml','caja','paquete','costal','docena') then raise exception 'invalid unit'; end if;
  if intent='inventory_count' then
   select count(*),min(s.base_unit) into n,chosen_unit from public.inventory_stock s
    where s.business_id=p_business and s.is_active and
     (entry->>'product_name' is null or lower(s.name)=lower(entry->>'product_name'))
     and (entry->>'brand' is null or lower(coalesce(s.brand,''))=lower(entry->>'brand'))
     and (entry->>'variant' is null or lower(coalesce(s.variant,''))=lower(entry->>'variant'))
     and (entry->>'color' is null or lower(coalesce(s.color,''))=lower(entry->>'color'))
     and (entry->>'size' is null or lower(coalesce(s.size,''))=lower(entry->>'size'))
     and (entry->>'sku' is null or lower(coalesce(s.sku,''))=lower(entry->>'sku'))
     and (wanted_unit is null or public.inventory_unit_factor(s.base_unit,wanted_unit) is not null);
   if n>1 and entry->>'product_name' is null then
    result:=jsonb_build_object('status','clarify','reason','inventory_ambiguous');
   elsif n=0 then
    result:=jsonb_build_object('status','inventory_count','products','[]'::jsonb,'total_quantity',0,'unit',wanted_unit);
   end if;
  end if;
  if result is null then
   select coalesce(sum(s.quantity),0),
    coalesce(sum(round(s.quantity*s.sale_price_original_cents/public.inventory_unit_factor(s.sale_price_unit,s.base_unit))) filter(where s.sale_price_original_cents is not null),0),
    coalesce(sum(round(s.quantity*s.cost_original_cents/public.inventory_unit_factor(s.cost_unit,s.base_unit))) filter(where s.cost_original_cents is not null),0),
    coalesce(sum(s.quantity) filter(where s.sale_price_original_cents is null),0),
    coalesce(sum(s.quantity) filter(where s.cost_original_cents is null),0),count(*)>20,
    count(distinct s.base_unit),count(*),min(s.base_unit)
   into total_qty,sale_value,cost_value,unpriced_sale,unpriced_cost,more_products,unit_count,product_count,chosen_unit
   from public.inventory_stock s where s.business_id=p_business and s.is_active and s.quantity>0
    and (intent<>'inventory_count' or ((entry->>'product_name' is null or lower(s.name)=lower(entry->>'product_name'))
     and (entry->>'brand' is null or lower(coalesce(s.brand,''))=lower(entry->>'brand'))
     and (entry->>'variant' is null or lower(coalesce(s.variant,''))=lower(entry->>'variant'))
     and (entry->>'color' is null or lower(coalesce(s.color,''))=lower(entry->>'color'))
     and (entry->>'size' is null or lower(coalesce(s.size,''))=lower(entry->>'size'))
     and (entry->>'sku' is null or lower(coalesce(s.sku,''))=lower(entry->>'sku'))
     and (wanted_unit is null or public.inventory_unit_factor(s.base_unit,wanted_unit) is not null)));
   select coalesce(jsonb_agg(jsonb_build_object('label',x.label,'quantity',x.display_qty,'quantity_text',x.display_qty::text,'unit',x.display_unit,
    'base_quantity',x.base_qty,'base_unit',x.base_unit,'id',x.id) order by x.base_qty desc,x.label),'[]'::jsonb)
   into products_json from (
    select pr.id,public.inventory_product_label(pr) as label,s.quantity as base_qty,s.base_unit,
     public.inventory_convert_quantity(s.quantity,s.base_unit,coalesce(wanted_unit,s.base_unit))::numeric(18,6) as display_qty,
     coalesce(wanted_unit,s.base_unit) as display_unit
    from public.inventory_stock s join public.products pr on pr.business_id=s.business_id and pr.id=s.product_id
    where s.business_id=p_business and s.is_active and s.quantity>0
     and (intent<>'inventory_count' or ((entry->>'product_name' is null or lower(s.name)=lower(entry->>'product_name'))
      and (entry->>'brand' is null or lower(coalesce(s.brand,''))=lower(entry->>'brand'))
      and (entry->>'variant' is null or lower(coalesce(s.variant,''))=lower(entry->>'variant'))
      and (entry->>'color' is null or lower(coalesce(s.color,''))=lower(entry->>'color'))
      and (entry->>'size' is null or lower(coalesce(s.size,''))=lower(entry->>'size'))
      and (entry->>'sku' is null or lower(coalesce(s.sku,''))=lower(entry->>'sku'))
      and (wanted_unit is null or public.inventory_unit_factor(s.base_unit,wanted_unit) is not null)))
    order by s.quantity desc,public.inventory_product_label(pr) limit 20
   ) x;
   if intent='inventory_count' and wanted_unit is not null and (product_count>20 or exists(
    select 1 from jsonb_array_elements(products_json) x
    where public.inventory_convert_quantity((x->>'base_quantity')::numeric,x->>'base_unit',wanted_unit)
     <>round(public.inventory_convert_quantity((x->>'base_quantity')::numeric,x->>'base_unit',wanted_unit),6)
   )) then result:=jsonb_build_object('status','clarify','reason','inventory_unit_incompatible');
   elsif intent in ('inventory_top','inventory_count') and unit_count>1 then result:=jsonb_build_object('status','clarify','reason','inventory_unit_mixed');
   else
    result:=jsonb_build_object('status',intent,'products',products_json,'total_quantity',
     case when unit_count<=1 then public.inventory_convert_quantity(total_qty,chosen_unit,coalesce(wanted_unit,chosen_unit))::numeric(18,6) end,
     'total_quantity_text',case when unit_count<=1 then public.inventory_convert_quantity(total_qty,chosen_unit,coalesce(wanted_unit,chosen_unit))::numeric(18,6)::text end,
     'unit',coalesce(wanted_unit,chosen_unit),'product_count',product_count,
     'label',entry->>'product_name','sale_value_cents',case when total_qty=unpriced_sale then null else sale_value::text end,
     'cost_value_cents',case when total_qty=unpriced_cost then null else cost_value::text end,
     'unpriced_sale_count',unpriced_sale,'unpriced_cost_count',unpriced_cost,'more',more_products);
   end if;
  end if;
 else
  begin
   for idx in 0..jsonb_array_length(p_commands)-1 loop
    entry:=p_commands->idx; intent:=entry->>'intent'; p:=null; m:=null; price:=null; cost:=null; amount:=null;
    price_base:=null;cost_base:=null;product_label:=null;available_qty:=null;
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
    if coalesce(entry->>'quantity','') !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$' then raise sqlstate 'P2001'; end if;
    qty:=(entry->>'quantity')::numeric(18,6);
    if qty<=0 or qty>100000000 then raise sqlstate 'P2001'; end if;
    input_unit:=entry->>'unit';price_unit:=entry->>'price_unit';v_cost_unit:=entry->>'cost_unit';
    -- Deployed 5.7 sends integer JSON quantities without a unit. Keep piece operations
    -- usable during the short migration/deployment interval; 5.7.1 sends strings.
    if input_unit is null and jsonb_typeof(entry->'quantity')='number' then input_unit:='pieza';end if;
    if input_unit is not null and input_unit not in ('pieza','kg','g','tonelada','litro','ml','caja','paquete','costal','docena') then raise sqlstate 'P2001'; end if;
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
    if intent='inventory_sale' and entry ? 'amount_cents' and entry ? 'unit_price_cents' then raise sqlstate 'P2001';end if;
    if intent='opening_stock' and input_unit is null then
     select count(*) into n from public.products where business_id=p_business and is_active
      and lower(name)=lower(coalesce(entry->>'product_name',''))
      and (entry->>'brand' is null or lower(coalesce(brand,''))=lower(entry->>'brand'))
      and (entry->>'variant' is null or lower(coalesce(variant,''))=lower(entry->>'variant'))
      and (entry->>'color' is null or lower(coalesce(color,''))=lower(entry->>'color'))
      and (entry->>'size' is null or lower(coalesce(size,''))=lower(entry->>'size'));
     if n=1 then intent:='stock_in';
     else reason:='inventory_unit_required';raise sqlstate 'P2001';end if;
    end if;
    if intent='opening_stock' then
     if length(trim(coalesce(entry->>'product_name',''))) not between 1 and 120 or input_unit is null then
      reason:='inventory_unit_required';raise sqlstate 'P2001';end if;
     select * into p from public.products where business_id=p_business
      and lower(name)=lower(entry->>'product_name')
      and lower(coalesce(brand,''))=lower(coalesce(entry->>'brand',''))
      and lower(coalesce(variant,''))=lower(coalesce(entry->>'variant',''))
      and lower(coalesce(color,''))=lower(coalesce(entry->>'color',''))
      and lower(coalesce(size,''))=lower(coalesce(entry->>'size',''))
      and lower(coalesce(sku,''))=lower(coalesce(entry->>'sku',''));
     if found then reason:='inventory_exists';raise sqlstate 'P2001'; end if;
     if input_unit in ('kg','g','tonelada') then chosen_unit:='kg';
     elsif input_unit in ('litro','ml') then chosen_unit:='litro';
     elsif input_unit='docena' then reason:='inventory_unit_required';raise sqlstate 'P2001';
     else chosen_unit:=input_unit;end if;
     factor:=public.inventory_unit_factor(input_unit,chosen_unit);
     if factor is null then raise sqlstate 'P2001';end if;
     if price is not null then
      if price_unit is null then price_unit:=input_unit;end if;
      factor:=public.inventory_unit_factor(price_unit,chosen_unit);
      if factor is null then reason:='inventory_unit_incompatible';raise sqlstate 'P2001';end if;
      price_base:=(price/factor)::numeric(24,6);
     end if;
     if cost is not null then
      if v_cost_unit is null then v_cost_unit:=input_unit;end if;
      factor:=public.inventory_unit_factor(v_cost_unit,chosen_unit);
      if factor is null then reason:='inventory_unit_incompatible';raise sqlstate 'P2001';end if;
      cost_base:=(cost/factor)::numeric(24,6);
     end if;
     insert into public.products(business_id,name,brand,variant,color,size,sku,base_unit,sale_price_cents,unit_cost_cents,
      sale_price_base_cents,cost_price_base_cents,sale_price_original_cents,sale_price_unit,cost_original_cents,cost_unit)
     values(p_business,entry->>'product_name',entry->>'brand',entry->>'variant',entry->>'color',entry->>'size',entry->>'sku',chosen_unit,
      case when price_base=round(price_base) then price_base::bigint end,
      case when cost_base=round(cost_base) then cost_base::bigint end,price_base,cost_base,price,price_unit,cost,v_cost_unit)
     returning * into p;
     current_qty:=0;
    else
     select count(*),(array_agg(id))[1] into n,p.id from public.products where business_id=p_business and is_active
      and (entry->>'product_name' is null or lower(name)=lower(entry->>'product_name'))
      and (entry->>'brand' is null or lower(coalesce(brand,''))=lower(entry->>'brand'))
      and (entry->>'variant' is null or lower(coalesce(variant,''))=lower(entry->>'variant'))
      and (entry->>'color' is null or lower(coalesce(color,''))=lower(entry->>'color'))
      and (entry->>'size' is null or lower(coalesce(size,''))=lower(entry->>'size'))
      and (entry->>'sku' is null or lower(coalesce(sku,''))=lower(entry->>'sku'))
      and (input_unit is null or public.inventory_unit_factor(input_unit,base_unit) is not null);
     if n<>1 then reason:=case when n=0 then 'inventory_missing' else 'inventory_ambiguous' end;raise sqlstate 'P2001';end if;
     select * into p from public.products where business_id=p_business and id=p.id;
     chosen_unit:=p.base_unit;
     if input_unit is null then input_unit:=chosen_unit;end if;
     select coalesce(sum(quantity_delta),0) into current_qty from public.inventory_movements where business_id=p_business and product_id=p.id;
     if price is not null then
      if price_unit is null then price_unit:=input_unit;end if;
      factor:=public.inventory_unit_factor(price_unit,chosen_unit);
      if factor is null then reason:='inventory_unit_incompatible';raise sqlstate 'P2001';end if;
      price_base:=(price/factor)::numeric(24,6);
     end if;
     if cost is not null then
      if v_cost_unit is null then v_cost_unit:=input_unit;end if;
      factor:=public.inventory_unit_factor(v_cost_unit,chosen_unit);
      if factor is null then reason:='inventory_unit_incompatible';raise sqlstate 'P2001';end if;
      cost_base:=(cost/factor)::numeric(24,6);
     end if;
     if intent='stock_in' and cost_base is not null then
      update public.products set cost_price_base_cents=cost_base,cost_original_cents=cost,cost_unit=v_cost_unit,
       unit_cost_cents=case when cost_base=round(cost_base) then cost_base::bigint end,updated_at=now()
       where id=p.id returning * into p;
     end if;
     if intent='inventory_sale' and price_base is not null and p.sale_price_base_cents is null then
      update public.products set sale_price_base_cents=price_base,sale_price_original_cents=price,sale_price_unit=price_unit,
       sale_price_cents=case when price_base=round(price_base) then price_base::bigint end,updated_at=now()
       where id=p.id returning * into p;
     end if;
    end if;
    base_qty:=qty*public.inventory_unit_factor(input_unit,chosen_unit);
    if base_qty is null or base_qty<>round(base_qty,6) or base_qty<=0 or base_qty>100000000000 then
     reason:='inventory_unit_incompatible';raise sqlstate 'P2001';end if;
    if chosen_unit in ('pieza','caja','paquete','costal') and base_qty<>trunc(base_qty) then
     reason:='inventory_unit_incompatible';raise sqlstate 'P2001';end if;
    product_label:=public.inventory_product_label(p);
    if intent='inventory_sale' then
     if current_qty<base_qty then reason:='stock_insufficient';available_qty:=current_qty;raise sqlstate 'P2001';end if;
     if entry ? 'amount_cents' then
      if entry->>'amount_cents' !~ '^[0-9]+$' then raise sqlstate 'P2001';end if;
      amount:=(entry->>'amount_cents')::bigint;
     else
      if price is not null then amount:=round(base_qty*price/public.inventory_unit_factor(price_unit,chosen_unit))::bigint;
      elsif p.sale_price_original_cents is not null then
       amount:=round(base_qty*p.sale_price_original_cents/public.inventory_unit_factor(p.sale_price_unit,chosen_unit))::bigint;
      else raise sqlstate 'P2001';end if;
     end if;
     if amount not between 1 and 100000000000 then raise sqlstate 'P2001';end if;
     insert into public.movements(business_id,actor_id,kind,amount_cents,description,occurred_on,source_message_id)
     values(p_business,p_actor,'sale',amount,product_label,day,msgid) returning * into m;
     insert into public.movement_audit(business_id,movement_id,actor_id,message_id,action,after_data)
     values(p_business,m.id,p_actor,msgid,'create',to_jsonb(m));
    end if;
    insert into public.inventory_movements(business_id,product_id,actor_id,kind,quantity_delta,occurred_on,unit_price_cents,unit_cost_cents,
     source_message_id,financial_movement_id,original_quantity,original_unit,base_unit,original_price_cents,original_price_unit,
     original_sale_price_cents,original_sale_price_unit,original_cost_cents,original_cost_unit,
     effective_price_base_cents,calculated_amount_cents)
    values(p_business,p.id,p_actor,case when intent='inventory_sale' then 'sale' else intent end,
     case when intent='inventory_sale' then -base_qty else base_qty end,day,
     case when price_base=round(price_base) then price_base::bigint end,
     case when coalesce(cost_base,p.cost_price_base_cents)=round(coalesce(cost_base,p.cost_price_base_cents)) then coalesce(cost_base,p.cost_price_base_cents)::bigint end,
     msgid,m.id,qty,input_unit,chosen_unit,coalesce(price,cost),case when price is not null then price_unit else v_cost_unit end,
     price,price_unit,cost,v_cost_unit,
     case when intent='inventory_sale' then coalesce(price_base,p.sale_price_base_cents) else coalesce(cost_base,p.cost_price_base_cents) end,
     amount) returning * into im;
    insert into public.inventory_audit(business_id,inventory_movement_id,actor_id,message_id,action,after_data)
    values(p_business,im.id,p_actor,msgid,'create',to_jsonb(im));
    entries:=entries||jsonb_build_array(jsonb_build_object('kind',intent,'product_id',p.id,'product_label',product_label,
     'quantity',qty,'quantity_text',qty::text,'unit',input_unit,'base_quantity',base_qty,'base_quantity_text',base_qty::text,'base_unit',chosen_unit,
     'stock_remaining',current_qty+im.quantity_delta,'stock_remaining_text',(current_qty+im.quantity_delta)::text,
     'stock_unit',chosen_unit,'inventory_movement_id',im.id,
     'movement_id',m.id,'amount_cents',amount));
   end loop;
   result:=jsonb_build_object('status',case when jsonb_array_length(p_commands)=1 then 'inventory_recorded' else 'inventory_batch_recorded' end,
    'operations',entries,'count',jsonb_array_length(entries));
  exception when sqlstate 'P2001' or unique_violation then
   result:=jsonb_build_object('status','clarify','reason',reason,'product_label',product_label,
    'available_quantity',available_qty,'available_unit',chosen_unit);
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
