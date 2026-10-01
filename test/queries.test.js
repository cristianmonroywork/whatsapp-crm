import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createLocalStore,DEMO_USER as actor,DEMO_BUSINESS as business} from '../scripts/local-store.js';
import {handleMessage} from '../src/service.js';
import {base} from '../src/interpret.js';
import {createHandler} from '../api/index.js';
import {money} from '../src/domain.js';
let store;
before(async()=>{store=await createLocalStore();});
after(async()=>{await store.db.close();});
beforeEach(async()=>{await store.db.exec('truncate businesses,profiles,auth.users cascade');await store.seed();});
const send=(text,raw,extra={})=>handleMessage({store,interpreter:async()=>raw,business,actor,channel:'web',externalId:randomUUID(),text,...extra});
const sale=(amount,date='today',extra={})=>send('venta',base('sale',{amount,date}),extra);
const expense=(amount,date='today')=>send('gasto',base('expense',{amount,date}));
const ask=(intent,extra={})=>send('consulta',base(intent,extra));
const day=async sql=>(await store.db.query(`select (${sql})::date::text as day`)).rows[0].day;

test('large aggregate amounts format exactly from cent strings',()=>{
 assert.equal(money('9007199254740993'),'$90,071,992,547,409.93');
});

test('today, yesterday, current and previous week, current and previous month use DB dates',async()=>{
 const today=await day("now() at time zone 'America/Mexico_City'");
 const yesterday=await day("(now() at time zone 'America/Mexico_City')-interval '1 day'");
 const lastWeek=await day("date_trunc('week',now() at time zone 'America/Mexico_City')-interval '7 days'");
 const thisWeek=await day("date_trunc('week',now() at time zone 'America/Mexico_City')");
 const lastMonth=await day("date_trunc('month',now() at time zone 'America/Mexico_City')-interval '1 month'");
 await sale('100','today');await sale('200','yesterday');await sale('300',lastWeek);await sale('400',lastMonth);
 const todayResult=await ask('totals',{metric:'sales'});assert.equal(todayResult.sales_cents,10000);assert.equal(todayResult.from,today);
 assert.equal((await ask('totals',{date:'yesterday',metric:'sales'})).sales_cents,20000);
 const week=await ask('totals',{period:'week',metric:'sales'});assert.equal(week.sales_cents,10000+(week.from<=await day("(now() at time zone 'America/Mexico_City')-interval '1 day'")?20000:0));
 assert.equal((await ask('totals',{period:'last_week',metric:'sales'})).sales_cents,30000+(yesterday<thisWeek?20000:0));
 assert.ok((await ask('totals',{period:'month',metric:'sales'})).sales_cents>=10000);
 const priorMonth=lastMonth.slice(0,7);
 assert.equal((await ask('totals',{period:'last_month',metric:'sales'})).sales_cents,
  40000+(lastWeek.startsWith(priorMonth)?30000:0)+(yesterday.startsWith(priorMonth)?20000:0));
});
test('expenses, explicit dates, range and invalid dates',async()=>{
 await expense('320');const today=await day("now() at time zone 'America/Mexico_City'");
 const result=await ask('totals',{period:'week',metric:'expenses'});assert.equal(result.expenses_cents,32000);assert.match(result.text,/gastos/);
 assert.equal((await ask('totals',{date:today,metric:'expenses'})).expenses_cents,32000);
 assert.equal((await ask('totals',{period:'range',from_date:today,to_date:today,metric:'expenses'})).expenses_cents,32000);
 assert.equal((await ask('totals',{date:'2026-02-31',metric:'sales'})).status,'clarify');
});
test('debtors and balances reflect payments, closed accounts and contact filters',async()=>{
 await send('Luis me debe 700',base('receivable',{amount:'700',contact:'Luis'}));
 await send('Pedro me debe 400',base('receivable',{amount:'400',contact:'Pedro'}));
 await send('Luis pagó 200',base('payment',{amount:'200',contact:'Luis'}));
 assert.equal((await ask('balance')).balance_cents,90000);
 const list=await ask('debtors');assert.deepEqual(list.debtors.map(d=>[d.contact,Number(d.balance_cents)]),[['Luis',50000],['Pedro',40000]]);
 assert.equal((await ask('balance',{contact:'Pedro'})).balance_cents,40000);
 await send('Pedro pagó 400',base('payment',{amount:'400',contact:'Pedro'}));
 assert.deepEqual((await ask('debtors')).debtors.map(d=>d.contact),['Luis']);
});
test('weekly summary, best day, ties and comparison are deterministic',async()=>{
 const monday=await day("date_trunc('week',now() at time zone 'America/Mexico_City')");
 const prevMon=await day("date_trunc('week',now() at time zone 'America/Mexico_City')-interval '7 days'");
 const prevTue=await day("date_trunc('week',now() at time zone 'America/Mexico_City')-interval '6 days'");
 await sale('2500',monday);await expense('350',monday);await sale('1000',prevMon);await sale('1000',prevTue);
 const summary=await ask('summary',{period:'week'});assert.equal(summary.sales_cents,250000);assert.equal(summary.expenses_cents,35000);assert.equal(summary.previous_sales_cents,200000);assert.equal(summary.movement_count,2);assert.match(summary.text,/mejor día/i);assert.match(summary.text,/más/);
 const comparison=await ask('comparison',{period:'week'});assert.match(comparison.text,/25%/);assert.match(comparison.text,/\$500\.00/);
 const tied=await ask('best_day',{period:'last_week'});assert.deepEqual(tied.days.map(d=>d.date),[prevMon,prevTue]);assert.match(tied.text,new RegExp(prevMon));assert.match(tied.text,new RegExp(prevTue));
});
test('zero previous period, empty business and general daily overview are safe',async()=>{
 const empty=await ask('summary',{period:'week'});assert.equal(empty.sales_cents,0);assert.equal(empty.movement_count,0);
 assert.match((await ask('best_day',{period:'week'})).text,/No hay ventas/);
 assert.match((await ask('debtors')).text,/No tienes cuentas/);
 await sale('900');const comparison=await ask('comparison',{period:'week'});assert.equal(comparison.previous_sales_cents,0);assert.match(comparison.text,/no hay porcentaje comparable/);
 const overview=await ask('business_overview');assert.equal(overview.sales_cents,90000);assert.match(overview.text,/Hoy vendiste \$900\.00/);
});
test('business timezone and membership isolate every query',async()=>{
 await store.db.query("update businesses set timezone='Pacific/Kiritimati' where id=$1",[business]);
 const localToday=await day("now() at time zone 'Pacific/Kiritimati'");
 await sale('700');assert.equal((await ask('totals',{metric:'sales'})).from,localToday);
 const outsider=randomUUID(),otherBusiness=randomUUID();await store.seed(outsider,otherBusiness,'Otro negocio','America/Los_Angeles');
 const other=await ask('totals',{metric:'sales'});assert.equal(other.sales_cents,70000);
 assert.equal((await send('consulta',base('totals',{metric:'sales'}),{actor:outsider,business:otherBusiness})).sales_cents,0);
 await assert.rejects(send('consulta',base('debtors'),{actor:outsider}),e=>e.status===403);
 await assert.rejects(store.query({p_business:business,p_actor:outsider,p_channel:'web',p_external_id:randomUUID(),p_fingerprint:'x',p_content:'x',p_command:{intent:'totals',period:'day'}}),/forbidden/);
});
test('authenticated database clients cannot call the privileged query RPC',async()=>{
 await store.db.exec('set role authenticated');
 try {await assert.rejects(store.db.query("select process_financial_query($1,$2,'web','x','x','x','{}',null)",[business,actor]),/permission denied/);}
 finally {await store.db.exec('reset role');}
});
test('query after a multi-operation message excludes later voided movements',async()=>{
 const batch={ambiguous:false,operations:[base('sale',{amount:'900'}),base('expense',{amount:'200'})]};
 await send('Vendí 900 y gasté 200',batch);await sale('300');
 const pending=await send('Elimina el último',base('delete_last'));
 await send(`CONFIRMAR ${pending.token}`,base('clarify'));
 const result=await ask('summary',{period:'week'});assert.equal(result.sales_cents,90000);assert.equal(result.expenses_cents,20000);assert.equal(result.movement_count,2);
});
test('audio transcription uses the same query path and does not create movements',async()=>{
 const wav=Buffer.alloc(44+32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40);
 await sale('900');const transcript='¿Cómo va mi negocio?';
 const server=createServer(createHandler({store,demoUser:actor,env:{},transcriber:async()=>({text:transcript}),interpreter:async()=>base('business_overview')}));
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try {const response=await fetch(`http://127.0.0.1:${server.address().port}/api/audio`,{method:'POST',headers:{'Content-Type':'audio/wav','X-CC-Business-Id':business,'X-CC-Message-Id':randomUUID()},body:wav});const result=await response.json();assert.equal(result.status,'business_overview');assert.match(result.text,/Escuché: ¿Cómo va mi negocio\?/);assert.equal(result.sales_cents,90000);}
 finally {await new Promise(done=>server.close(done));}
 assert.equal((await store.db.query('select count(*)::integer as count from movements')).rows[0].count,1);
});
