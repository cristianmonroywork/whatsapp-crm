import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {createServer} from 'node:http';
import {createLocalStore,DEMO_USER as actor,DEMO_BUSINESS as business} from '../scripts/local-store.js';
import {handleMessage} from '../src/service.js';
import {base,demoInterpret,interpret,schema} from '../src/interpret.js';
import {normalize,cents,control} from '../src/domain.js';
import {receiveWhatsApp,validSignature} from '../src/whatsapp.js';
import {createHandler} from '../api/index.js';
import {SupabaseStore} from '../src/store.js';
let store;
before(async()=>{store=await createLocalStore();});
after(async()=>{await store.db.close();});
beforeEach(async()=>{await store.db.exec('truncate businesses,profiles,auth.users cascade');await store.seed();});
const send=(text,extra={})=>handleMessage({store,interpreter:demoInterpret,business,actor,channel:'web',externalId:randomUUID(),text,...extra});
const command=(intent,extra={})=>send('Mensaje de prueba',{interpreter:async()=>base(intent,extra)});
const confirm=r=>send(`CONFIRMAR ${r.token}`);
async function query(sql,args=[]) {return (await store.db.query(sql,args)).rows;}

test('Sprint 1: Spanish text → interpretation → PostgreSQL → daily sales $900',async()=>{
 const r=await send('Vendí 3 playeras en $900');assert.equal(r.status,'recorded');assert.equal(r.amount_cents,90000);
 const total=await send('¿Cuánto vendí hoy?');assert.equal(total.sales_cents,90000);assert.match(total.text,/Vendiste \$900\.00/);
 assert.equal((await query('select count(*) as n from messages'))[0].n,2);
});
test('expenses, daily totals and unit-price multiplication remain deterministic',async()=>{
 await send('Vendí 3 playeras en $900');await send('Gasté $180 de gasolina');
 await command('sale',{quantity:3,unit_price:'0.10'});
 const r=await send('¿Cuánto vendí hoy?');assert.equal(r.sales_cents,90030);assert.equal(r.expenses_cents,18000);
});
test('correction waits for exact confirmation and retains before/after provenance',async()=>{
 await send('Vendí 3 playeras en $900');const p=await send('No, eran $800');assert.equal(p.status,'confirmation');
 assert.equal((await send('¿Cuánto vendí hoy?')).sales_cents,90000);
 await send('sí');assert.equal((await send('¿Cuánto vendí hoy?')).sales_cents,90000);
 await confirm(p);assert.equal((await send('¿Cuánto vendí hoy?')).sales_cents,80000);
 const [audit]=await query("select * from movement_audit where action='correct_last'");assert.equal(audit.before_data.amount_cents,90000);assert.equal(audit.after_data.amount_cents,80000);
});
test('safe deletion is soft, actor-scoped and confirmed',async()=>{
 await send('Gasté $180 de gasolina');const p=await send('Elimina el último');assert.equal((await send('¿Cuánto vendí hoy?')).expenses_cents,18000);
 await confirm(p);assert.equal((await send('¿Cuánto vendí hoy?')).expenses_cents,0);
 assert.ok((await query('select voided_at from movements'))[0].voided_at);assert.equal((await confirm(p)).reason,'expired');
});
test('receivable, partial and final payment do not double count sales',async()=>{
 await send('Pedro me debe $600');await send('Pedro ya me pagó $300');assert.equal((await send('¿Cuánto me deben?')).balance_cents,30000);
 const r=await send('Pedro ya me pagó $300');assert.equal(r.balance_cents,0);
 const totals=await send('¿Cuánto vendí hoy?');assert.equal(totals.sales_cents,0);assert.equal(totals.payments_cents,60000);
});
test('unknown debt, overpayment and multiple debts are non-mutating',async()=>{
 assert.equal((await send('Pedro me pagó $100')).reason,'no_debt');await send('Pedro me debe $600');
 assert.equal((await send('Pedro me pagó $700')).reason,'overpayment');await send('Pedro me debe $200');
 assert.equal((await send('Pedro me pagó $100')).reason,'multiple_debts');assert.equal((await query("select count(*) as n from movements where kind='payment'"))[0].n,0);
});
test('idempotency on repeated and concurrent messages; altered payload conflicts',async()=>{
 const id=randomUUID();const responses=await Promise.all(Array.from({length:5},()=>send('Vendí 3 playeras en $900',{externalId:id})));
 assert.equal(responses.filter(r=>!r.duplicate).length,1);assert.equal((await send('¿Cuánto vendí hoy?')).sales_cents,90000);
 await assert.rejects(send('Gasté $180 de gasolina',{externalId:id}),e=>e.status===409);
});
test('concurrent payments cannot exceed remaining balance',async()=>{
 await send('Pedro me debe $600');const rs=await Promise.all([send('Pedro me pagó $400'),send('Pedro me pagó $400')]);
 assert.equal(rs.filter(r=>r.status==='recorded').length,1);assert.equal((await send('¿Cuánto me deben?')).balance_cents,20000);
});
test('business isolation and membership enforcement in service and SQL',async()=>{
 const other=randomUUID(),otherBusiness=randomUUID();await store.seed(other,otherBusiness);await send('Vendí 3 playeras en $900');
 assert.equal((await send('¿Cuánto vendí hoy?',{actor:other,business:otherBusiness})).sales_cents,0);
 await assert.rejects(send('¿Cuánto vendí hoy?',{actor:other}),e=>e.status===403);
 await assert.rejects(store.process({p_business:business,p_actor:other,p_channel:'web',p_external_id:'bad',p_fingerprint:'x',p_content:'x',p_command:{intent:'totals'}}),/forbidden/);
});
test('RLS hides other businesses and clients cannot directly write or invoke privileged RPC',async()=>{
 const other=randomUUID(),otherBusiness=randomUUID();await store.seed(other,otherBusiness);await send('Vendí 3 playeras en $900');
 await store.db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);await store.db.exec('set role authenticated');
 try {
  assert.equal((await query('select * from movements')).length,0);
  assert.equal((await query('select * from businesses'))[0].id,otherBusiness);
  await assert.rejects(query("insert into businesses(name) values('hack')"),/permission denied/);
  await assert.rejects(query('select * from messages'),/permission denied/);
  await assert.rejects(query("select process_command($1,$2,'web','x','x','x','{}',null)",[business,other]),/permission denied/);
 } finally {await store.db.exec('reset role');}
});
test('timezone determines local date, yesterday, week and month queries',async()=>{
 await store.db.query("update businesses set timezone='Pacific/Kiritimati' where id=$1",[business]);
 const [{day}]=await query("select (now() at time zone 'Pacific/Kiritimati')::date::text as day");
 const r=await send('Vendí 3 playeras en $900');assert.equal(r.date,day);
 await command('sale',{amount:'100',date:'yesterday'});
 assert.equal((await send('¿Cuánto vendí hoy?')).sales_cents,90000);
 assert.equal((await command('totals',{date:'yesterday'})).sales_cents,10000);
 const month=await command('totals',{period:'month'});assert.equal(month.from,`${day.slice(0,7)}-01`);
 await assert.rejects(store.db.query("update businesses set timezone='bad' where id=$1",[business]),/invalid timezone/);
});
test('confirmation expires, cancellation clears it, and new request supersedes old',async()=>{
 await send('Vendí 3 playeras en $900');let p=await send('Elimina el último');await send('CANCELAR');assert.equal((await confirm(p)).reason,'expired');
 p=await send('Elimina el último');await query("update pending_actions set expires_at=now()-interval '1 second'");assert.equal((await confirm(p)).reason,'expired');
 p=await send('Elimina el último');await send('No, eran $800');assert.equal((await confirm(p)).reason,'expired');
});
test('pending target is fixed; new sale cannot be accidentally corrected',async()=>{
 await send('Vendí 3 playeras en $900');const p=await send('No, eran $800');await send('Vendí 2 playeras en $400');await confirm(p);
 assert.equal((await send('¿Cuánto vendí hoy?')).sales_cents,120000);
});
test('confirmation cannot cross actors or channels; stale version is rejected',async()=>{
 await send('Vendí 3 playeras en $900');const p=await send('Elimina el último');const other=randomUUID();await store.seed(other,business);
 assert.equal((await send(`CONFIRMAR ${p.token}`,{actor:other})).reason,'expired');
 assert.equal((await send(`CONFIRMAR ${p.token}`,{channel:'whatsapp'})).reason,'expired');
 await query('update movements set version=version+1');assert.equal((await confirm(p)).reason,'changed');
});
test('linked payments protect receivable corrections/deletion; payment correction adjusts balance',async()=>{
 await send('Pedro me debe $600');await send('Pedro me pagó $300');
 let p=await send('No, eran $700');assert.equal((await confirm(p)).reason,'overpayment');
 p=await send('No, eran $200');await confirm(p);assert.equal((await send('¿Cuánto me deben?')).balance_cents,40000);
 p=await send('Elimina el último');await confirm(p);assert.equal((await send('¿Cuánto me deben?')).balance_cents,60000);
 // A second member pays while the debt remains the first actor's last movement.
 const other=randomUUID();await store.seed(other,business);await send('Pedro me pagó $300',{actor:other});
 p=await send('Elimina el último');assert.equal((await confirm(p)).reason,'linked_payments');
 p=await send('No, eran $200');assert.equal((await confirm(p)).reason,'linked_payments');
});
test('invalid AI output and ambiguous requests never mutate',async()=>{
 for(const raw of [null,{},base('sale',{amount:'-1'}),base('sale',{amount:'1e6'}),base('sale',{amount:'100',date:'2026-02-31'}),base('sale',{amount:'100',ambiguous:true}),base('confirm'),base('payment',{amount:'300'})]) {
  assert.equal((await send('x',{interpreter:async()=>raw})).status,'clarify');
 }
 assert.equal((await query('select count(*) as n from movements'))[0].n,0);
 assert.equal(cents('0.01'),1);assert.equal(control('sí'),null);assert.equal(normalize(base('sale',{unit_price:'0.10',quantity:3})).amount_cents,30);
});
test('interpreter failures leave no financial receipt and allow safe retry',async()=>{
 const id=randomUUID();await assert.rejects(send('Vendí 3 playeras en $900',{externalId:id,interpreter:async()=>{throw new Error('timeout');}}));
 assert.equal((await query('select count(*) as n from messages'))[0].n,0);
 assert.equal((await send('Vendí 3 playeras en $900',{externalId:id})).status,'recorded');
});
test('Gemini adapter requests JSON Schema; handles blocked, truncated and malformed responses',async()=>{
 const mock=output=>async(url,options)=>{
  const request=JSON.parse(options.body);
  assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(options.headers['x-goog-api-key'],'test');
  assert.equal(request.generationConfig.responseMimeType,'application/json');
  assert.deepEqual(request.generationConfig.responseJsonSchema.required,schema.required);
  assert.equal(request.contents[0].parts[0].text,'venta');
  assert.ok(!request.tools);
  return {ok:true,json:async()=>output};
 };
 const raw=base('sale',{amount:'900'});
 assert.deepEqual(await interpret('venta',{key:'test',fetcher:mock({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(raw)}]}}]})}),raw);
 const generic=output=>async()=>({ok:true,json:async()=>output});
 assert.equal((await interpret('x',{key:'test',fetcher:generic({promptFeedback:{blockReason:'SAFETY'}})})).intent,'clarify');
 assert.equal((await interpret('x',{key:'test',fetcher:generic({candidates:[{finishReason:'SAFETY'}]})})).intent,'clarify');
 await assert.rejects(interpret('x',{key:'test',fetcher:generic({candidates:[{finishReason:'MAX_TOKENS'}]})}),/Incomplete/);
 await assert.rejects(interpret('x',{key:'test',fetcher:generic({candidates:[{finishReason:'STOP',content:{parts:[{text:'invalid'}]}}]})}),/Invalid/);
});
test('Supabase adapter uses parameterized RPC envelope and sends secret only server-side',async()=>{
 let captured;const supa=new SupabaseStore({SUPABASE_URL:'https://isolated.example',SUPABASE_SERVICE_ROLE_KEY:'server-secret',SUPABASE_ANON_KEY:'anon'},async(url,options)=>{captured={url,options};return {ok:true,text:async()=>JSON.stringify({status:'totals'})};});
 const args={p_business:business,p_actor:actor,p_command:{intent:'totals'}};await supa.process(args);
 assert.match(captured.url,/rest\/v1\/rpc\/process_command$/);assert.deepEqual(JSON.parse(captured.options.body),args);assert.equal(captured.options.headers.Authorization,'Bearer server-secret');
});
test('WhatsApp signature, batched replay, media preparation and durable outbound retry',async()=>{
 const raw=Buffer.from('{"a":1}');const sig='sha256='+createHmac('sha256','secret').update(raw).digest('hex');
 assert.ok(validSignature(raw,sig,'secret'));assert.ok(!validSignature(Buffer.from('changed'),sig,'secret'));assert.ok(!validSignature(raw,'bad','secret'));
 await query("insert into channel_bindings(business_id,user_id,channel,phone_number_id,sender_id) values($1,$2,'whatsapp','phone','sender')",[business,actor]);
 const payload={object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'phone'},messages:[{id:'wamid.1',from:'sender',type:'text',text:{body:'Vendí 3 playeras en $900'}},{id:'wamid.2',from:'sender',type:'audio',audio:{id:'media.1'}}]}}]}]};
 let sends=0;const args={store,interpreter:demoInterpret,env:{WHATSAPP_GRAPH_VERSION:'v99.0',WHATSAPP_ACCESS_TOKEN:'test'},fetcher:async()=>{sends++;return {ok:true,json:async()=>({messages:[{id:'outbound'}]})};}};
 await assert.rejects(receiveWhatsApp(payload,{...args,fetcher:async()=>({ok:false})}),/Meta delivery failed/);
 await receiveWhatsApp(payload,args);await receiveWhatsApp(payload,args);assert.equal(sends,2);
 assert.equal((await send('¿Cuánto vendí hoy?')).sales_cents,90000);assert.equal((await query("select count(*) as n from outbox where status='sent'"))[0].n,2);
 assert.equal((await query("select media from messages where external_id='wamid.2'"))[0].media.id,'media.1');
});
test('HTTP chat path works; production refuses demo, auth and body limits enforced',async()=>{
 const handler=createHandler({store,interpreter:demoInterpret,demoUser:actor,env:{}});
 const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=`http://127.0.0.1:${server.address().port}`;
 try {
  const post=body=>fetch(root+'/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let r=await post({businessId:business,id:randomUUID(),text:'Vendí 3 playeras en $900'});assert.equal(r.status,200);
  r=await post({businessId:business,id:randomUUID(),text:'¿Cuánto vendí hoy?'});assert.equal((await r.json()).sales_cents,90000);
  assert.equal((await post({businessId:business,id:'big',text:'x'.repeat(17000)})).status,413);
  assert.equal((await fetch(root+'/api/messages',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'})).status,403);
 } finally {await new Promise(resolve=>server.close(resolve));}
 const secured=createServer(createHandler({store,env:{}}));await new Promise(resolve=>secured.listen(0,'127.0.0.1',resolve));
 try {assert.equal((await fetch(`http://127.0.0.1:${secured.address().port}/api/session`)).status,401);} finally {await new Promise(resolve=>secured.close(resolve));}
});
test('rate limit persists per actor and duplicate retries bypass AI quota',async()=>{
 const id=randomUUID();await send('Vendí 3 playeras en $900',{externalId:id});
 await query('update request_limits set requests=30');
 assert.equal((await send('Vendí 3 playeras en $900',{externalId:id})).duplicate,true);
 await assert.rejects(send('Gasté $180 de gasolina'),e=>e.status===429);
});

test('Supabase handles successful empty responses from inserts and updates',async()=>{
 const s=new SupabaseStore({SUPABASE_URL:'https://isolated.example',SUPABASE_SERVICE_ROLE_KEY:'test',SUPABASE_ANON_KEY:'test'},async()=>({ok:true,status:201,text:async()=>''}));
 assert.equal(await s.request('outbox',{method:'POST'}),null);
});
test('future dates are refused with a clarification and no financial write',async()=>{
 const result=await command('sale',{amount:'900',date:'2099-01-01'});assert.equal(result.status,'clarify');
 assert.equal((await query('select count(*) as n from movements'))[0].n,0);
});
test('HTTP webhook validates exact raw signature and demo cannot run on Vercel',async()=>{
 const env={WHATSAPP_ENABLED:'true',WHATSAPP_APP_SECRET:'secret',WHATSAPP_VERIFY_TOKEN:'verify',WHATSAPP_ACCESS_TOKEN:'test',WHATSAPP_GRAPH_VERSION:'v99.0'};
 const srv=createServer(createHandler({store,env}));await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
 const root=`http://127.0.0.1:${srv.address().port}`;
 try {
  const verify=await fetch(root+'/api/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123');assert.equal(await verify.text(),'123');
  assert.equal((await fetch(root+'/api/whatsapp?hub.mode=subscribe&hub.verify_token=wrong')).status,403);
  const raw='{ "object": "whatsapp_business_account", "entry": [] }';
  assert.equal((await fetch(root+'/api/whatsapp',{method:'POST',body:raw})).status,401);
  const signature='sha256='+createHmac('sha256','secret').update(raw).digest('hex');
  assert.equal((await fetch(root+'/api/whatsapp',{method:'POST',headers:{'x-hub-signature-256':signature},body:raw})).status,200);
  assert.equal((await fetch(root+'/api/whatsapp',{method:'POST',headers:{'x-hub-signature-256':signature},body:raw+' '})).status,401);
 }finally{await new Promise(resolve=>srv.close(resolve));}
 const production=createServer(createHandler({store,demoUser:actor,env:{VERCEL:'1'}}));await new Promise(resolve=>production.listen(0,'127.0.0.1',resolve));
 try{assert.equal((await fetch(`http://127.0.0.1:${production.address().port}/api/session`)).status,503);}finally{await new Promise(resolve=>production.close(resolve));}
});
