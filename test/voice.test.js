import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createLocalStore,DEMO_USER as actor,DEMO_BUSINESS as business} from '../scripts/local-store.js';
import {createHandler} from '../api/index.js';
import {base} from '../src/interpret.js';
import {validateAudio,transcribeAudio,multipleVoiceOperations,webmDurationSeconds} from '../src/voice.js';

let store;
before(async()=>{store=await createLocalStore();});
after(async()=>{await store.db.close();});
beforeEach(async()=>{await store.db.exec('truncate businesses,profiles,auth.users cascade');await store.seed();});
function wav(){const pcm=Buffer.alloc(16000*2);const b=Buffer.alloc(44+pcm.length);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(pcm.length,40);pcm.copy(b,44);return b;}
const phrases=new Map([
 ['Vendí novecientos pesos.',base('sale',{amount:'900'})],
 ['Hoy saqué mil quinientos de venta.',base('sale',{amount:'1500'})],
 ['Gasté trescientos veinte en gasolina.',base('expense',{amount:'320',description:'gasolina'})],
 ['Pedro me debe seiscientos.',base('receivable',{amount:'600',contact:'Pedro'})],
 ['Pedro ya me pagó trescientos.',base('payment',{amount:'300',contact:'Pedro'})],
 ['Ayer vendí dos mil.',base('sale',{amount:'2000',date:'yesterday'})]
]);
async function serverFor(transcriber){const server=createServer(createHandler({store,demoUser:actor,env:{},transcriber,interpreter:async text=>phrases.get(text)||base('clarify',{ambiguous:true})}));await new Promise(done=>server.listen(0,'127.0.0.1',done));return {server,url:`http://127.0.0.1:${server.address().port}/api/audio`};}
const post=(url,audio=wav(),id=randomUUID(),mime='audio/wav')=>fetch(url,{method:'POST',headers:{'Content-Type':mime,'X-CC-Business-Id':business,'X-CC-Message-Id':id},body:audio});
async function count(table){return (await store.db.query(`select count(*)::int as n from ${table}`)).rows[0].n;}

test('spoken single operations use the existing deterministic financial pipeline',async()=>{
 let transcript='';const {server,url}=await serverFor(async()=>({text:transcript,provider:'mock',model:'test'}));
 try {
  for(const [phrase,intent] of phrases){transcript=phrase;const response=await post(url);assert.equal(response.status,200,phrase);const result=await response.json();assert.equal(result.status,'recorded',phrase);assert.match(result.text,new RegExp(`Escuché: ${phrase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));assert.equal(result.amount_cents,Number(intent.amount)*100);}
  assert.equal(await count('movements'),6);assert.equal(await count('messages'),6);assert.equal(await count('movement_audit'),6);
  const rows=(await store.db.query('select content,media,response,id from messages order by created_at')).rows;
  assert.ok(rows.every(row=>row.media.type==='audio'&&row.media.sha256&&row.media.duration_seconds&&row.media.transcript===row.content&&row.response.movement_id));
  assert.ok(rows.every(row=>!JSON.stringify(row.media).includes('data:audio')));
 }finally{await new Promise(done=>server.close(done));}
});
test('empty, invalid, oversized and overlong audio are rejected before transcription',async()=>{
 let calls=0;const {server,url}=await serverFor(async()=>{calls++;return {text:'Vendí novecientos pesos.'};});
 try{
  assert.equal((await post(url,Buffer.alloc(0))).status,400);
  assert.equal((await post(url,Buffer.from('not audio'))).status,415);
  assert.equal((await post(url,wav(),randomUUID(),'text/plain')).status,415);
  assert.equal((await post(url,Buffer.alloc(3_000_001))).status,413);
  const long=Buffer.alloc(44+61*32000);wav().copy(long,0,0,44);long.writeUInt32LE(long.length-8,4);long.writeUInt32LE(long.length-44,40);assert.equal((await post(url,long)).status,413);
  assert.equal(calls,0);assert.equal(await count('movements'),0);
 }finally{await new Promise(done=>server.close(done));}
});
test('ambiguous or multiple operations make no movement; provider errors are retryable',async()=>{
 let transcript='';let fail=false;const {server,url}=await serverFor(async()=>{if(fail)throw Object.assign(new Error('provider unavailable'),{status:503});return {text:transcript};});
 try{
  for(const phrase of ['', 'Vendí algo', 'Vendí 900 y gasté 300']){transcript=phrase;const result=await (await post(url)).json();assert.equal(result.status,'clarify');if(phrase.includes(' y '))assert.match(result.text,/Envíalas por separado/);}
  assert.equal(multipleVoiceOperations('Vendí 900 y gasté 300'),true);
  assert.equal(await count('movements'),0);
  fail=true;const id=randomUUID();assert.equal((await post(url,wav(),id)).status,503);assert.equal(await count('messages'),3);
  fail=false;transcript='Vendí novecientos pesos.';assert.equal((await post(url,wav(),id)).status,200);assert.equal(await count('movements'),1);
 }finally{await new Promise(done=>server.close(done));}
});
test('audio retry is idempotent, even when transcriber output would change',async()=>{
 let calls=0;const {server,url}=await serverFor(async()=>({text:++calls===1?'Vendí novecientos pesos.':'Gasté trescientos veinte en gasolina.'}));
 try{
  const id=randomUUID();const first=await (await post(url,wav(),id)).json();const second=await (await post(url,wav(),id)).json();assert.equal(first.status,'recorded');assert.equal(second.duplicate,true);assert.equal(second.transcript,'Vendí novecientos pesos.');assert.equal(calls,1);assert.equal(await count('movements'),1);assert.equal(await count('messages'),1);
  const changed=wav();changed[100]=1;assert.equal((await post(url,changed,id)).status,409);
 }finally{await new Promise(done=>server.close(done));}
});
test('Gemini transcription adapter sends inline audio and no financial tools',async()=>{
 const bytes=wav();assert.equal((await validateAudio(bytes,'audio/wav')).duration_seconds,1);
 const result=await transcribeAudio(bytes,{mime:'audio/wav',key:'test',fetcher:async(url,options)=>{assert.match(url,/gemini-3\.5-flash-lite:generateContent$/);const body=JSON.parse(options.body);assert.equal(body.contents[0].parts[1].inlineData.mimeType,'audio/wav');assert.equal(body.contents[0].parts[1].inlineData.data,bytes.toString('base64'));assert.ok(!body.tools);return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:'Gasté 350 pesos de gasolina'}]}}]})};}});
 assert.equal(result.text,'Gasté 350 pesos de gasolina');
});
test('WebM without declared duration is bounded using packet timestamps',()=>{
 const header=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3,0x87,0x42,0x82,0x84]),Buffer.from('webm')]);
 const segment=Buffer.from([0x18,0x53,0x80,0x67,0x01,0xff,0xff,0xff,0xff,0xff,0xff,0xff]);
 const cluster=Buffer.from([0x1f,0x43,0xb6,0x75,0x8a,0xe7,0x82,0x03,0xe8,0xa3,0x84,0x81,0x00,0x00,0x80]);
 assert.equal(webmDurationSeconds(Buffer.concat([header,segment,cluster])),1.12);
});
