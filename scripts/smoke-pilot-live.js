// Opt-in Sprint 5.5 check. Creates and deactivates only a new test pilot in the confirmed project.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SupabaseStore} from '../src/store.js';
import {handleMessage} from '../src/service.js';
import {interpret} from '../src/interpret.js';
const env=process.env,ref='vixbjjjeewcjawwemvnx';
if(env.ALLOW_LIVE_SMOKE!=='isolated-project'||env.SUPABASE_PROJECT_REF_CONFIRM!==ref||new URL(env.SUPABASE_URL).host!==`${ref}.supabase.co`)throw Error('Cuenta Clara target not confirmed');
if(!env.TEST_USER_ID||!env.GEMINI_API_KEY)throw Error('Smoke configuration incomplete');
const store=new SupabaseStore(env),actor=env.TEST_USER_ID,name=`Smoke Pilot 5.5 ${new Date().toISOString()}`;
const profile=await store.request(`profiles?id=eq.${actor}&select=id`);assert.equal(profile.length,1);
await store.request('pilot_operators?on_conflict=user_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({user_id:actor})});
assert.equal(await store.operator(actor),true);
const business=await store.createPilotBusiness(actor,name,'America/Mexico_City');
const send=(text,id=randomUUID())=>handleMessage({store,interpreter:interpret,business:business.id,actor,channel:'web',externalId:id,text});
try {
 assert.equal(business.is_pilot,true);assert.equal(await store.membership(actor,business.id),true);
 const id=randomUUID(),sale=await send('Vendí $125',id);assert.equal(sale.status,'recorded');assert.equal(Number(sale.amount_cents),12500);
 assert.equal((await send('Vendí $125',id)).duplicate,true);
 const query=await send('¿Cuánto vendí hoy?');assert.equal(query.status,'totals');assert.equal(Number(query.sales_cents),12500);
 const pilots=await store.dashboard(actor);const row=pilots.find(p=>p.id===business.id);assert.ok(row);assert.equal(Number(row.messages),2);assert.equal(Number(row.operations),1);assert.equal(Number(row.queries),1);
 const events=await store.request(`pilot_events?business_id=eq.${business.id}&select=event_type`);assert.ok(events.some(x=>x.event_type==='transaction_created'));assert.ok(events.some(x=>x.event_type==='query_executed'));
 console.log(JSON.stringify({passed:true,project:ref,business_id:business.id,is_pilot:true,sales_today_cents:Number(query.sales_cents),messages:Number(row.messages),operations:Number(row.operations),queries:Number(row.queries)}));
} finally {
 const result=await store.deactivatePilot(actor,business.id,name,'DESACTIVAR PILOTO');assert.equal(result.is_active,false);assert.equal(await store.membership(actor,business.id),false);
}
