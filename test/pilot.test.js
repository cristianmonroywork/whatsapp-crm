import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createLocalStore,DEMO_USER as actor,DEMO_BUSINESS as business} from '../scripts/local-store.js';
import {handleMessage} from '../src/service.js';
import {base} from '../src/interpret.js';
import {createHandler} from '../api/index.js';
import {wavPreview} from '../public/audio-preview.js';
let store;
before(async()=>{store=await createLocalStore();});
after(async()=>{await store.db.close();});
beforeEach(async()=>{await store.db.exec('truncate businesses,profiles,auth.users cascade');await store.seed();});
const send=(text,raw,extra={})=>handleMessage({store,interpreter:async()=>raw,business,actor,channel:'web',externalId:randomUUID(),text,...extra});
async function server(handler,fn){const app=createServer(handler);await new Promise(done=>app.listen(0,'127.0.0.1',done));try{return await fn(`http://127.0.0.1:${app.address().port}`);}finally{await new Promise(done=>app.close(done));}}

test('new pilot business creates profile, owner membership, flag and signup events atomically',async()=>{
 const newUser=randomUUID();await store.db.query('insert into auth.users(id,email) values($1,$2)',[newUser,'pilot@example.test']);
 const b=await store.createPilotBusiness(newUser,'Puesto del barrio','America/Cancun');
 assert.equal(b.is_pilot,true);assert.equal(b.timezone,'America/Cancun');assert.equal(await store.membership(newUser,b.id),true);
 const rows=(await store.db.query('select role from memberships where business_id=$1 and user_id=$2',[b.id,newUser])).rows;assert.equal(rows[0].role,'owner');
 const events=(await store.db.query('select event_type from pilot_events where business_id=$1 order by event_type',[b.id])).rows.map(x=>x.event_type);
 assert.deepEqual(events,['business_created','signup_completed']);
 await assert.rejects(store.createPilotBusiness(newUser,'Otro','America/Cancun'),/already exists/);
 await assert.rejects(store.createPilotBusiness(newUser,'Otro','Invalid\/Zone'),/invalid timezone/);
});

test('pilot events count each batch movement, query, ambiguity, correction and voice without duplicating retries',async()=>{
 await store.db.query('update businesses set is_pilot=true where id=$1',[business]);
 const id=randomUUID(),batch={ambiguous:false,operations:[base('sale',{amount:'900'}),base('expense',{amount:'200'})]};
 const first=await handleMessage({store,interpreter:async()=>batch,business,actor,channel:'web',externalId:id,text:'Vendí 900 y gasté 200'});
 assert.equal(first.status,'batch_recorded');
 const duplicate=await handleMessage({store,interpreter:async()=>batch,business,actor,channel:'web',externalId:id,text:'Vendí 900 y gasté 200'});assert.equal(duplicate.duplicate,true);
 await send('¿Cuánto vendí hoy?',base('totals',{metric:'sales'}));
 await send('No sé cuánto gasté',base('clarify',{ambiguous:true}));
 await send('Vendí 100',base('sale',{amount:'100'}));
 const pending=await send('Elimina el último',base('delete_last'));await send(`CONFIRMAR ${pending.token}`,base('clarify'));
 const counts=Object.fromEntries((await store.db.query('select event_type,count(*)::integer as n from pilot_events group by event_type')).rows.map(x=>[x.event_type,x.n]));
 assert.equal(counts.transaction_created,3);assert.equal(counts.query_executed,1);assert.equal(counts.ambiguity_returned,1);assert.equal(counts.correction_requested,1);assert.equal(counts.deletion_confirmed,1);assert.equal(counts.message_text_sent,6);
});

test('daily and minute limits are scoped to actor and business',async()=>{
 assert.equal(await store.quota(actor,business,{perMinute:2,perDay:3}),true);
 assert.equal(await store.quota(actor,business,{perMinute:2,perDay:3}),true);
 assert.equal(await store.quota(actor,business,{perMinute:2,perDay:3}),false);
 const rows=(await store.db.query('select requests from pilot_daily_limits where business_id=$1',[business])).rows;
 assert.equal(rows[0].requests,2);
});

test('operator sees only pilot businesses and can deactivate with strong confirmation and audit',async()=>{
 await store.db.query('update businesses set is_pilot=true where id=$1',[business]);
 await store.db.query('insert into pilot_operators(user_id) values($1)',[actor]);
 await store.presence(actor,business);
 await send('Vendí $800',base('sale',{amount:'800'}));
 const outsider=randomUUID();await store.seed(outsider,randomUUID(),'No piloto');
 await assert.rejects(store.dashboard(outsider),/forbidden/);
 const dashboard=await store.dashboard(actor);assert.equal(dashboard.length,1);assert.equal(dashboard[0].name,'Mi negocio de prueba');assert.equal(Number(dashboard[0].operations),1);assert.equal(Number(dashboard[0].messages),1);assert.equal(Number(dashboard[0].active_sessions),1);
 await assert.rejects(store.deactivatePilot(actor,business,'Nombre incorrecto','DESACTIVAR PILOTO'),/confirmation mismatch/);
 await assert.rejects(store.deactivatePilot(outsider,business,'Mi negocio de prueba','DESACTIVAR PILOTO'),/forbidden/);
 const result=await store.deactivatePilot(actor,business,'Mi negocio de prueba','DESACTIVAR PILOTO');assert.equal(result.is_active,false);
 assert.equal(await store.membership(actor,business),false);assert.deepEqual(await store.businesses(actor),[]);
 await assert.rejects(send('Vendí 100',base('sale',{amount:'100'})),e=>e.status===403);
 const events=(await store.db.query("select count(*)::integer as n from pilot_events where business_id=$1 and event_type='pilot_deactivated'",[business])).rows;assert.equal(events[0].n,1);
});

test('empty period has a useful answer without technical text',async()=>{
 const result=await send('¿Cuánto vendí esta semana?',base('totals',{period:'week',metric:'sales'}));
 assert.match(result.text,/Aún no tienes ventas registradas esta semana/);
});

test('signup uses invite code and never sends service role to browser',async()=>{
 const seen=[];const fake={auth:async(path,{body})=>{seen.push({path,email:body.email});return {user:{id:randomUUID()},access_token:'local-test-token',expires_in:3600};}};
 await server(createHandler({store:fake,env:{PILOT_SIGNUP_ENABLED:'true',PILOT_INVITE_CODE:'invitacion-prueba',VERCEL:'1'}}),async root=>{
  const invalid=await fetch(`${root}/api/signup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'pilot@example.test',password:'clave-segura-de-prueba',inviteCode:'incorrecto'})});assert.equal(invalid.status,400);
  const valid=await fetch(`${root}/api/signup`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'pilot@example.test',password:'clave-segura-de-prueba',inviteCode:'invitacion-prueba'})});assert.equal(valid.status,200);assert.match(valid.headers.get('set-cookie'),/HttpOnly/);assert.match(valid.headers.get('set-cookie'),/Secure/);assert.deepEqual(seen,[{path:'signup',email:'pilot@example.test'}]);
 });
});

test('HTTP session, onboarding and admin reject unauthorized users',async()=>{
 await server(createHandler({store,demoUser:actor,env:{}}),async root=>{
  const session=await (await fetch(`${root}/api/session`)).json();assert.equal(session.operator,false);
  const denied=await fetch(`${root}/api/admin/pilots`);assert.equal(denied.status,403);assert.doesNotMatch((await denied.json()).error,/SQL|stack|token/i);
  const created=await fetch(`${root}/api/businesses`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Piloto nuevo',timezone:'America/Mexico_City'})});assert.equal(created.status,200);assert.equal((await created.json()).is_pilot,true);
 });
});

test('new pilot tables and privileged RPC stay closed to authenticated database clients',async()=>{
 await store.db.exec('set role authenticated');
 try{
  await assert.rejects(store.db.query('select * from pilot_events'),/permission denied/);
  await assert.rejects(store.db.query('select * from pilot_operators'),/permission denied/);
  await assert.rejects(store.db.query('select create_pilot_business($1,$2,$3)',[actor,'Intruso','America/Mexico_City']),/permission denied/);
  await assert.rejects(store.db.query('select deactivate_pilot_business($1,$2,$3,$4)',[actor,business,'Mi negocio de prueba','DESACTIVAR PILOTO']),/permission denied/);
 }finally{await store.db.exec('reset role');}
});

test('expired session and technical failures return safe understandable errors',async()=>{
 const fake={auth:async()=>{throw Object.assign(new Error('internal token 123'),{status:401});}};
 await server(createHandler({store:fake,env:{}}),async root=>{
  const noCookie=await fetch(`${root}/api/session`);assert.equal(noCookie.status,401);assert.match((await noCookie.json()).error,/Inicia sesión/);
  const expired=await fetch(`${root}/api/session`,{headers:{Cookie:'cc_session=expired'}});assert.equal(expired.status,401);const body=await expired.json();assert.match(body.error,/sesión venció/);assert.doesNotMatch(body.error,/internal|token|123/);
 });
 const broken={...store,membership:async()=>true,quota:async()=>true,receipt:async()=>null,process:async()=>{throw Object.assign(new Error('database role secret'),{status:503});},event:async()=>{}};
 await server(createHandler({store:broken,demoUser:actor,env:{},interpreter:async()=>base('sale',{amount:'100'})}),async root=>{
  const res=await fetch(`${root}/api/messages`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businessId:business,id:randomUUID(),text:'Vendí $100'})});
  assert.equal(res.status,503);assert.match((await res.json()).error,/Reintenta/);
 });
});

test('recorded PCM preview is a playable-size WAV kept separate from upload',async()=>{
 const preview=wavPreview([new Float32Array([0,0.5,-0.5,1,-1])],16000);
 assert.equal(preview.type,'audio/wav');assert.equal(preview.size,54);
 const bytes=Buffer.from(await preview.arrayBuffer());assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WAVE');
 assert.equal(bytes.readUInt32LE(24),16000);assert.equal(bytes.readUInt32LE(40),10);assert.equal(bytes.readInt16LE(44),0);assert.ok(bytes.readInt16LE(46)>16000);
});
