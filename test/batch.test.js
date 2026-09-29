import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createLocalStore,DEMO_USER as actor,DEMO_BUSINESS as business} from '../scripts/local-store.js';
import {handleMessage} from '../src/service.js';
import {base} from '../src/interpret.js';
import {createHandler} from '../api/index.js';

let store;
before(async()=>{store=await createLocalStore();});
after(async()=>{await store.db.close();});
beforeEach(async()=>{await store.db.exec('truncate businesses,profiles,auth.users cascade');await store.seed();});
const ops=(...operations)=>({ambiguous:false,operations});
const send=(text,raw,id=randomUUID())=>handleMessage({store,interpreter:async()=>raw,business,actor,channel:'web',externalId:id,text});
const rows=async table=>(await store.db.query(`select * from ${table} order by created_at`)).rows;

test('mixed sale/expense/receivable are atomic, ordered and individually audited',async()=>{
 const text='Hoy vendí 2,600 pesos, gasté 450 de gasolina y Luis me quedó a deber 800.';
 const result=await send(text,ops(base('sale',{amount:'2600'}),base('expense',{amount:'450',description:'gasolina'}),base('receivable',{amount:'800',contact:'Luis'})));
 assert.equal(result.status,'batch_recorded');assert.equal(result.count,3);
 assert.match(result.text,/\$2,600\.00 en ventas/);assert.match(result.text,/\$450\.00 de gasto/);assert.match(result.text,/\$800\.00 por cobrar a Luis/);
 assert.deepEqual((await rows('movements')).map(r=>[r.kind,r.amount_cents]),[['sale',260000],['expense',45000],['receivable',80000]]);
 const messages=await rows('messages'),audit=await rows('movement_audit');assert.equal(messages.length,1);assert.equal(audit.length,3);
 assert.ok((await rows('movements')).every(r=>r.source_message_id===messages[0].id));assert.ok(audit.every(r=>r.message_id===messages[0].id&&r.action==='create'));
});
test('sale and expense in one text; aggregate sale and independent debt',async()=>{
 await send('Vendí 3 playeras en $900 y gasté $200 de gasolina.',ops(base('sale',{amount:'900',quantity:3}),base('expense',{amount:'200',description:'gasolina'})));
 let movements=await rows('movements');assert.deepEqual(movements.map(r=>r.amount_cents),[90000,20000]);
 await send('Hoy saqué $4,000 de venta y Juan me quedó a deber $800.',ops(base('sale',{amount:'4000'}),base('receivable',{amount:'800',contact:'Juan'})));
 movements=await rows('movements');assert.deepEqual(movements.map(r=>r.kind),['sale','expense','sale','receivable']);
});
test('existing debt payment and expense share a batch without double-counting sales',async()=>{
 await send('Pedro me debe $600',base('receivable',{amount:'600',contact:'Pedro'}));
 const result=await send('Pedro me pagó $300 y gasté $150 en comida.',ops(base('payment',{amount:'300',contact:'Pedro'}),base('expense',{amount:'150',description:'comida'})));
 assert.equal(result.status,'batch_recorded');assert.deepEqual(result.operations.map(r=>r.kind),['payment','expense']);
 const balances=(await store.db.query('select balance_cents from accounts_receivable')).rows;assert.equal(Number(balances[0].balance_cents),30000);
 assert.equal((await rows('movements')).filter(r=>r.kind==='sale').length,0);
});
test('different dates and multiple receivables keep individual provenance',async()=>{
 await send('Ayer vendí $2,500, hoy llevo $1,800.',ops(base('sale',{amount:'2500',date:'yesterday'}),base('sale',{amount:'1800',date:'today'})));
 const sales=(await rows('movements'));assert.notEqual(String(sales[0].occurred_on),String(sales[1].occurred_on));
 await send('Luis me debe $700 y Pedro $400.',ops(base('receivable',{amount:'700',contact:'Luis'}),base('receivable',{amount:'400',contact:'Pedro'})));
 assert.deepEqual((await rows('movements')).map(r=>r.amount_cents),[250000,180000,70000,40000]);
});
test('quantity times unit price is computed in cents, not by Gemini',async()=>{
 const result=await send('Vendí dos pantalones de $600 cada uno y una chamarra de $900.',ops(base('sale',{unit_price:'600',quantity:2,description:'pantalones'}),base('sale',{amount:'900',description:'chamarra'})));
 assert.deepEqual(result.operations.map(r=>r.amount_cents),[120000,90000]);assert.match(result.text,/\$2,100\.00 en ventas/);
});
test('full credit sale creates one sale and one linked receivable',async()=>{
 const result=await send('Le vendí a Pedro $600 y me lo quedó a deber.',ops(base('sale',{amount:'600',contact:'Pedro'}),base('receivable',{amount:null,contact:'Pedro',sale_ref:0})));
 assert.equal(result.status,'batch_recorded');assert.deepEqual(result.operations.map(r=>r.amount_cents),[60000,60000]);
 assert.deepEqual((await rows('movements')).map(r=>r.kind),['sale','receivable']);
});
test('partial upfront payment is not a second sale or a debt payment',async()=>{
 const result=await send('Le vendí a Juan $1,000, me pagó $400 y me debe $600.',ops(base('sale',{amount:'1000',contact:'Juan',upfront_paid:'400'}),base('receivable',{amount:'600',contact:'Juan',sale_ref:0})));
 assert.equal(result.status,'batch_recorded');assert.deepEqual((await rows('movements')).map(r=>[r.kind,r.amount_cents]),[['sale',100000],['receivable',60000]]);
 assert.equal((await rows('messages'))[0].interpretation.operations[0].upfront_paid_cents,40000);
});
test('invalid or ambiguous member prevents the whole batch',async()=>{
 for(const [text,raw] of [
  ['Gasté $500 y Juan me pagó algo.',ops(base('expense',{amount:'500'}),base('payment',{amount:null,contact:'Juan',ambiguous:true}))],
  ['Creo que vendí como 2 o 3 mil.',{ambiguous:true,operations:[base('sale',{amount:'2000',ambiguous:true})]}],
  ['Gasté más o menos $500.',{ambiguous:true,operations:[base('expense',{amount:'500',ambiguous:true})]}],
  ['Pedro me debe lo mismo de la vez pasada.',{ambiguous:true,operations:[base('receivable',{amount:null,contact:'Pedro',ambiguous:true})]}],
  ['Venta y gasto inválido',ops(base('sale',{amount:'900'}),base('expense',{amount:'-1'}))]
 ]) assert.equal((await send(text,raw)).status,'clarify');
 assert.equal((await rows('movements')).length,0);assert.equal((await rows('movement_audit')).length,0);
});
test('database payment failure rolls back sale, contacts and audit but keeps a clarify receipt',async()=>{
 const result=await send('Vendí $900 y Pedro me pagó $300.',ops(base('sale',{amount:'900'}),base('payment',{amount:'300',contact:'Pedro'})));
 assert.equal(result.status,'clarify');assert.equal(result.reason,'batch_invalid');
 assert.equal((await rows('messages')).length,1);assert.equal((await rows('movements')).length,0);assert.equal((await rows('movement_audit')).length,0);
});
test('same message ID replays the whole result without duplicate movements',async()=>{
 const id=randomUUID(),raw=ops(base('sale',{amount:'900'}),base('expense',{amount:'200'}));
 const first=await send('Vendí $900 y gasté $200',raw,id),again=await send('Vendí $900 y gasté $200',raw,id);
 assert.equal(first.status,'batch_recorded');assert.equal(again.duplicate,true);assert.equal((await rows('messages')).length,1);assert.equal((await rows('movements')).length,2);assert.equal((await rows('movement_audit')).length,2);
 await assert.rejects(send('Vendí $800 y gasté $200',raw,id),e=>e.status===409);
});
test('batch RPC rejects actors without business membership',async()=>{
 const outsider=randomUUID();
 await assert.rejects(store.batch({p_business:business,p_actor:outsider,p_channel:'web',p_external_id:randomUUID(),p_fingerprint:'isolated',p_content:'Vendí $900 y gasté $200',p_commands:[{intent:'sale',amount_cents:90000,date:'today'},{intent:'expense',amount_cents:20000,date:'today'}]}));
 assert.equal((await rows('messages')).length,0);
 assert.equal((await rows('movements')).length,0);
});
test('generic correction after a batch asks for a specific operation',async()=>{
 await send('Vendí $900 y gasté $200',ops(base('sale',{amount:'900'}),base('expense',{amount:'200'})));
 const result=await send('Corrige el último a $100',base('correct_last',{amount:'100'}));
 assert.equal(result.status,'clarify');assert.equal(result.reason,'batch_target');assert.equal((await store.db.query('select count(*)::int as n from pending_actions')).rows[0].n,0);assert.equal((await rows('movements')).length,2);
});
test('audio transcript uses the same batch interpreter and transaction',async()=>{
 const audio=Buffer.alloc(44+32000);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(32000,40);
 const transcript='Vendí 3 playeras en $900 y gasté $200 de gasolina.';
 const server=createServer(createHandler({store,demoUser:actor,env:{},transcriber:async()=>({text:transcript}),interpreter:async()=>ops(base('sale',{amount:'900'}),base('expense',{amount:'200',description:'gasolina'}))}));
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/audio`,{method:'POST',headers:{'Content-Type':'audio/wav','X-CC-Business-Id':business,'X-CC-Message-Id':randomUUID()},body:audio});
  const result=await response.json();assert.equal(response.status,200);assert.equal(result.status,'batch_recorded');assert.match(result.text,/Escuché: Vendí 3 playeras/);
  assert.equal((await rows('movements')).length,2);assert.equal((await rows('messages'))[0].media.type,'audio');
 }finally{await new Promise(done=>server.close(done));}
});
