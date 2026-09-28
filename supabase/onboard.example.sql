-- Run in the NEW project's SQL Editor after creating a dedicated Auth pilot user.
-- Replace this marker yourself. Does not reuse any existing business.
do $$
declare
 pilot_user uuid := 'REPLACE_WITH_NEW_AUTH_USER_UUID';
 new_business uuid;
begin
 insert into public.profiles(id,display_name) values(pilot_user,'Vendedor piloto') on conflict(id) do nothing;
 insert into public.businesses(name,timezone) values('Mi negocio piloto','America/Mexico_City') returning id into new_business;
 insert into public.memberships(business_id,user_id,role) values(new_business,pilot_user,'owner');
 raise notice 'New isolated business ID: %',new_business;
end $$;

-- Later, after confirming ownership of the sender and receiver:
-- insert into public.channel_bindings(business_id,user_id,channel,phone_number_id,sender_id)
-- values('NEW_BUSINESS_UUID','NEW_AUTH_USER_UUID','whatsapp','META_RECEIVER_PHONE_NUMBER_ID','SELLER_WHATSAPP_ID');
