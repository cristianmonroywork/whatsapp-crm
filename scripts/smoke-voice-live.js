import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {SupabaseStore} from '../src/store.js';
import {createHandler} from '../api/index.js';

const env=process.env;
const ref='vixbjjjeewcjawwemvnx';
if(env.ALLOW_LIVE_SMOKE!=='isolated-project'||env.SUPABASE_PROJECT_REF_CONFIRM!==ref||new URL(env.SUPABASE_URL).host!==`${ref}.supabase.co`) throw new Error('Cuenta Clara Supabase target not confirmed');
if(!env.TEST_USER_ID||!env.DEPLOY_BUSINESS_ID||!env.DEPLOY_BUSINESS_NAME_CONFIRM||!env.GEMINI_API_KEY) throw new Error('Smoke configuration incomplete');
const store=new SupabaseStore(env);
const businesses=await store.businesses(env.TEST_USER_ID);
if(!businesses.some(b=>b.id===env.DEPLOY_BUSINESS_ID&&b.name===env.DEPLOY_BUSINESS_NAME_CONFIRM)) throw new Error('Pilot business mismatch');
const bytes=await readFile('/private/tmp/cuenta-clara-sprint3.wav');
const server=createServer(createHandler({store,demoUser:env.TEST_USER_ID,env:{GEMINI_API_KEY:env.GEMINI_API_KEY,GEMINI_MODEL:env.GEMINI_MODEL,GEMINI_TRANSCRIBE_MODEL:env.GEMINI_TRANSCRIBE_MODEL}}));
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const root=`http://127.0.0.1:${server.address().port}`;
try {
 const id=randomUUID();
 const send=()=>fetch(`${root}/api/audio`,{method:'POST',headers:{'Content-Type':'audio/wav','X-CC-Business-Id':env.DEPLOY_BUSINESS_ID,'X-CC-Message-Id':id},body:bytes});
 const first=await send();const firstBody=await first.json();
 if(first.status!==200||firstBody.status!=='recorded'||firstBody.amount_cents!==35000) throw new Error(`Voice recording failed: HTTP ${first.status}, status ${firstBody.status||'none'}`);
 const second=await send();const secondBody=await second.json();
 if(second.status!==200||!secondBody.duplicate) throw new Error('Voice idempotency failed');
 const total=await fetch(`${root}/api/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businessId:env.DEPLOY_BUSINESS_ID,id:randomUUID(),text:'¿Cuánto gasté hoy?'})});
 const totalBody=await total.json();
 if(total.status!==200||totalBody.expenses_cents<35000) throw new Error('Voice total query failed');
 const rows=await store.request(`messages?business_id=eq.${env.DEPLOY_BUSINESS_ID}&external_id=eq.${id}&select=id,content,media,response&limit=1`);
 if(rows.length!==1||rows[0].media?.type!=='audio'||rows[0].response?.movement_id!==firstBody.movement_id) throw new Error('Supabase voice trace mismatch');
 const movements=await store.request(`movements?source_message_id=eq.${rows[0].id}&select=id,amount_cents&limit=2`);
 const audits=await store.request(`movement_audit?message_id=eq.${rows[0].id}&select=id&limit=2`);
 if(movements.length!==1||movements[0].amount_cents!==35000||audits.length!==1) throw new Error('Supabase voice movement/audit mismatch');
 console.log(JSON.stringify({supabase_project:ref,voice_status:firstBody.status,amount_cents:firstBody.amount_cents,transcript:firstBody.transcript,duplicate:secondBody.duplicate,messages:rows.length,movements:movements.length,audits:audits.length,expenses_today_cents:totalBody.expenses_cents}));
} finally {await new Promise(done=>server.close(done));}
