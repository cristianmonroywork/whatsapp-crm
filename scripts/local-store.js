import {PGlite} from '@electric-sql/pglite';
import {dirname} from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
export const DEMO_USER='11111111-1111-4111-8111-111111111111';
export const DEMO_BUSINESS='22222222-2222-4222-8222-222222222222';
export async function createLocalStore(path) {
 if(path) await mkdir(dirname(path),{recursive:true});
 const db=new PGlite(path);await db.waitReady;
 const exists=await db.query("select to_regclass('public.businesses') as name");
 if(!exists.rows[0].name) {
  await db.exec(`create schema auth;
   create role anon; create role authenticated; create role service_role bypassrls;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema public,auth to anon,authenticated,service_role;
   grant execute on function auth.uid() to authenticated;`);
  await db.exec(await readFile(new URL('../supabase/migrations/001_initial.sql',import.meta.url),'utf8'));
 }
 const batch=await db.query("select to_regprocedure('public.process_batch(uuid,uuid,text,text,text,text,jsonb,jsonb)') as name");
 if(!batch.rows[0].name) await db.exec(await readFile(new URL('../supabase/migrations/002_batches.sql',import.meta.url),'utf8'));
 const queries=await db.query("select to_regprocedure('public.process_financial_query(uuid,uuid,text,text,text,text,jsonb,jsonb)') as name");
 if(!queries.rows[0].name) await db.exec(await readFile(new URL('../supabase/migrations/003_queries.sql',import.meta.url),'utf8'));
 await db.exec('alter table auth.users add column if not exists email text');
 const pilot=await db.query("select to_regprocedure('public.create_pilot_business(uuid,text,text)') as name");
 if(!pilot.rows[0].name) await db.exec(await readFile(new URL('../supabase/migrations/004_pilot.sql',import.meta.url),'utf8'));
 const inventory=await db.query("select to_regprocedure('public.process_inventory_message(uuid,uuid,text,text,text,text,jsonb,jsonb)') as name");
 if(!inventory.rows[0].name) await db.exec(await readFile(new URL('../supabase/migrations/005_inventory.sql',import.meta.url),'utf8'));
 const units=await db.query("select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='base_unit'");
 if(!units.rows.length) await db.exec(await readFile(new URL('../supabase/migrations/006_inventory_units.sql',import.meta.url),'utf8'));
 const store={
  db,
  async seed(user=DEMO_USER,business=DEMO_BUSINESS,name='Mi negocio de prueba',timezone='America/Mexico_City') {
   await db.query('insert into auth.users(id) values($1) on conflict do nothing',[user]);
   await db.query('insert into profiles(id,display_name) values($1,$2) on conflict do nothing',[user,'Vendedor de prueba']);
   await db.query('insert into businesses(id,name,timezone) values($1,$2,$3) on conflict do nothing',[business,name,timezone]);
   await db.query('insert into memberships(business_id,user_id) values($1,$2) on conflict do nothing',[business,user]);
  },
  async membership(actor,business) {return (await db.query('select 1 from memberships m join businesses b on b.id=m.business_id where m.business_id=$1 and m.user_id=$2 and b.is_active',[business,actor])).rows.length===1;},
  async businesses(actor) {return (await db.query('select b.id,b.name,b.timezone,b.is_pilot from businesses b join memberships m on b.id=m.business_id where m.user_id=$1 and b.is_active',[actor])).rows;},
  async receipt(business,channel,id) {return (await db.query('select id,actor_id,fingerprint,response,media from messages where business_id=$1 and channel=$2 and external_id=$3',[business,channel,id])).rows[0];},
  async process(a) {return (await db.query('select process_command($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) as result',[a.p_business,a.p_actor,a.p_channel,a.p_external_id,a.p_fingerprint,a.p_content,JSON.stringify(a.p_command),JSON.stringify(a.p_media)])).rows[0].result;},
  async batch(a) {return (await db.query('select process_batch($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) as result',[a.p_business,a.p_actor,a.p_channel,a.p_external_id,a.p_fingerprint,a.p_content,JSON.stringify(a.p_commands),JSON.stringify(a.p_media)])).rows[0].result;},
  async inventory(a) {return (await db.query('select process_inventory_message($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) as result',[a.p_business,a.p_actor,a.p_channel,a.p_external_id,a.p_fingerprint,a.p_content,JSON.stringify(a.p_commands),JSON.stringify(a.p_media)])).rows[0].result;},
  async query(a) {return (await db.query('select process_financial_query($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) as result',[a.p_business,a.p_actor,a.p_channel,a.p_external_id,a.p_fingerprint,a.p_content,JSON.stringify(a.p_command),JSON.stringify(a.p_media)])).rows[0].result;},
  async quota(actor,business,limits={}) {return (await db.query('select consume_pilot_quota($1,$2,$3,$4) as allowed',[actor,business,limits.perMinute||30,limits.perDay||250])).rows[0].allowed;},
  async createPilotBusiness(actor,name,timezone) {return (await db.query('select create_pilot_business($1,$2,$3) as value',[actor,name,timezone])).rows[0].value;},
  async operator(actor) {return (await db.query('select 1 from pilot_operators where user_id=$1',[actor])).rows.length===1;},
  async dashboard(actor) {return (await db.query('select pilot_dashboard($1) as value',[actor])).rows[0].value;},
  async deactivatePilot(actor,business,name,phrase) {return (await db.query('select deactivate_pilot_business($1,$2,$3,$4) as value',[actor,business,name,phrase])).rows[0].value;},
  async event(actor,business,type,code=null) {await db.query('insert into pilot_events(user_id,business_id,event_type,error_code) values($1,$2,$3,$4)',[actor,business,type,code]);},
  async presence(actor,business) {await db.query('insert into pilot_presence(business_id,user_id,last_seen_at) values($1,$2,now()) on conflict(business_id,user_id) do update set last_seen_at=now()',[business,actor]);},
  async binding(phone,sender) {return (await db.query("select business_id,user_id from channel_bindings where channel='whatsapp' and phone_number_id=$1 and sender_id=$2",[phone,sender])).rows[0];},
  async enqueue(id,binding,body) {await db.query('insert into outbox(message_id,business_id,recipient,phone_number_id,body) values($1,$2,$3,$4,$5) on conflict do nothing',[id,binding.business_id,binding.sender,binding.phone,body]);},
  async claim(id) {return (await db.query('select * from claim_delivery($1)',[id])).rows;},
  async delivery(id) {return (await db.query('select status from outbox where message_id=$1',[id])).rows[0];},
  async markDelivery(id,patch) {await db.query('update outbox set status=$2,lease_until=$3,provider_id=coalesce($4,provider_id),sent_at=coalesce($5,sent_at) where message_id=$1',[id,patch.status,patch.lease_until,patch.provider_id||null,patch.sent_at||null]);}
 };
 return store;
}
