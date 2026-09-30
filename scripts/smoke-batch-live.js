// Opt-in end-to-end test. Creates a dedicated business in the confirmed Vendixa Supabase project.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {SupabaseStore} from '../src/store.js';
import {interpret} from '../src/interpret.js';
import {handleMessage} from '../src/service.js';
import {createHandler} from '../api/index.js';

const env=process.env, ref='vixbjjjeewcjawwemvnx';
if(env.ALLOW_LIVE_SMOKE!=='isolated-project'||env.SUPABASE_PROJECT_REF_CONFIRM!==ref||new URL(env.SUPABASE_URL).host!==`${ref}.supabase.co`) throw new Error('Vendixa Supabase target not confirmed');
if(!env.TEST_USER_ID||!env.GEMINI_API_KEY) throw new Error('Smoke configuration incomplete');
const store=new SupabaseStore(env), actor=env.TEST_USER_ID, business=randomUUID();
await store.request('profiles?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({id:actor,display_name:'Piloto Sprint 4'})});
await store.request('businesses',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({id:business,name:`Smoke Sprint 4 ${new Date().toISOString()}`,timezone:'America/Mexico_City'})});
await store.request('memberships',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({business_id:business,user_id:actor})});
const send=(text,id=randomUUID())=>handleMessage({store,interpreter:interpret,actor,business,channel:'web',externalId:id,text});
const phrase='Hoy vendí 2,600 pesos, gasté 450 de gasolina y Luis me quedó a deber 800.';
const id=randomUUID(),first=await send(phrase,id);
assert.equal(first.status,'batch_recorded');
assert.deepEqual(first.operations.map(op=>[op.kind,Number(op.amount_cents)]),[['sale',260000],['expense',45000],['receivable',80000]]);
assert.equal((await send(phrase,id)).duplicate,true);
const totals=await send('¿Cuánto vendí hoy?');assert.equal(Number(totals.sales_cents),260000);
const rejected=await send('Vendí $900 y Pedro me pagó $300.');assert.equal(rejected.status,'clarify');
let audioStatus='not supplied';
if(env.VOICE_BATCH_SMOKE_FILE) {
 const bytes=await readFile(env.VOICE_BATCH_SMOKE_FILE);
 const server=createServer(createHandler({store,demoUser:actor,env:{GEMINI_API_KEY:env.GEMINI_API_KEY,GEMINI_MODEL:env.GEMINI_MODEL,GEMINI_TRANSCRIBE_MODEL:env.GEMINI_TRANSCRIBE_MODEL}}));
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try {
  const audioId=randomUUID();
  const sendAudio=()=>fetch(`http://127.0.0.1:${server.address().port}/api/audio`,{method:'POST',headers:{'Content-Type':'audio/wav','X-CC-Business-Id':business,'X-CC-Message-Id':audioId},body:bytes});
  const response=await sendAudio(),result=await response.json();
  assert.equal(response.status,200);assert.equal(result.status,'batch_recorded');
  assert.match(result.text,/^Escuché:/);assert.equal(result.operations.length,2);
  assert.equal((await (await sendAudio()).json()).duplicate,true);
  audioStatus=result.transcript;
 }finally{await new Promise(done=>server.close(done));}
}
const messages=await store.request(`messages?business_id=eq.${business}&select=id,external_id,response,media`);
const movements=await store.request(`movements?business_id=eq.${business}&select=id,kind,amount_cents,source_message_id`);
const audits=await store.request(`movement_audit?business_id=eq.${business}&select=id,movement_id,message_id,action`);
const source=messages.find(row=>row.external_id===id);
assert.ok(source);assert.equal(messages.filter(row=>row.external_id===id).length,1);
const mainMovements=movements.filter(row=>row.source_message_id===source.id);
assert.equal(mainMovements.length,3);
assert.equal(audits.filter(row=>row.message_id===source.id).length,3);
assert.ok(mainMovements.every(row=>audits.some(audit=>audit.movement_id===row.id&&audit.action==='create')));
if(env.VOICE_BATCH_SMOKE_FILE) {
 const audioMessage=messages.find(row=>row.media?.type==='audio');
 assert.ok(audioMessage);assert.equal(movements.filter(row=>row.source_message_id===audioMessage.id).length,2);
 assert.equal(audits.filter(row=>row.message_id===audioMessage.id).length,2);
}
console.log(JSON.stringify({passed:true,supabase_project:ref,business_id:business,sales_today_cents:Number(totals.sales_cents),main_batch_movements:mainMovements.length,messages:messages.length,movements:movements.length,audits:audits.length,audio:audioStatus,note:'Dedicated Sprint 4 test business retained for inspection.'},null,2));
