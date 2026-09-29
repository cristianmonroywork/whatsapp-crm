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
 const store={
  db,
  async seed(user=DEMO_USER,business=DEMO_BUSINESS,name='Mi negocio de prueba',timezone='America/Mexico_City') {
   await db.query('insert into auth.users(id) values($1) on conflict do nothing',[user]);
   await db.query('insert into profiles(id,display_name) values($1,$2) on conflict do nothing',[user,'Vendedor de prueba']);
   await db.query('insert into businesses(id,name,timezone) values($1,$2,$3) on conflict do nothing',[business,name,timezone]);
   await db.query('insert into memberships(business_id,user_id) values($1,$2) on conflict do nothing',[business,user]);
  },
  async membership(actor,business) {return (await db.query('select 1 from memberships where business_id=$1 and user_id=$2',[business,actor])).rows.length===1;},
  async businesses(actor) {return (await db.query('select b.id,b.name,b.timezone from businesses b join memberships m on b.id=m.business_id where m.user_id=$1',[actor])).rows;},
  async receipt(business,channel,id) {return (await db.query('select id,actor_id,fingerprint,response,media from messages where business_id=$1 and channel=$2 and external_id=$3',[business,channel,id])).rows[0];},
  async process(a) {return (await db.query('select process_command($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) as result',[a.p_business,a.p_actor,a.p_channel,a.p_external_id,a.p_fingerprint,a.p_content,JSON.stringify(a.p_command),JSON.stringify(a.p_media)])).rows[0].result;},
  async quota(actor) {return (await db.query('select consume_quota($1) as allowed',[actor])).rows[0].allowed;},
  async binding(phone,sender) {return (await db.query("select business_id,user_id from channel_bindings where channel='whatsapp' and phone_number_id=$1 and sender_id=$2",[phone,sender])).rows[0];},
  async enqueue(id,binding,body) {await db.query('insert into outbox(message_id,business_id,recipient,phone_number_id,body) values($1,$2,$3,$4,$5) on conflict do nothing',[id,binding.business_id,binding.sender,binding.phone,body]);},
  async claim(id) {return (await db.query('select * from claim_delivery($1)',[id])).rows;},
  async delivery(id) {return (await db.query('select status from outbox where message_id=$1',[id])).rows[0];},
  async markDelivery(id,patch) {await db.query('update outbox set status=$2,lease_until=$3,provider_id=coalesce($4,provider_id),sent_at=coalesce($5,sent_at) where message_id=$1',[id,patch.status,patch.lease_until,patch.provider_id||null,patch.sent_at||null]);}
 };
 return store;
}
