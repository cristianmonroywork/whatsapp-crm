import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createLocalStore,DEMO_USER as actor,DEMO_BUSINESS as business} from '../scripts/local-store.js';
import {handleMessage} from '../src/service.js';
import {base,schema} from '../src/interpret.js';
import {normalize} from '../src/domain.js';
import {createHandler} from '../api/index.js';

let store;
before(async()=>{store=await createLocalStore();});
after(async()=>{await store.db.close();});
beforeEach(async()=>{await store.db.exec('truncate businesses,profiles,auth.users cascade');await store.seed();});
const ops=(...operations)=>({ambiguous:false,operations});
const send=(text,raw,extra={})=>handleMessage({store,interpreter:async()=>raw,business,actor,channel:'web',externalId:randomUUID(),text,...extra});
const product=(brand='X',extra={})=>base('opening_stock',{product_name:'gorra',brand,quantity:100,unit_price:brand==='X'?'1500':'1200',...extra});
const stock=async()=>(await store.db.query('select name,brand,color,size,quantity,sale_price_cents,unit_cost_cents from inventory_stock order by brand,color,size')).rows.map(row=>({...row,quantity:Number(row.quantity)}));
const count=async table=>Number((await store.db.query(`select count(*) as n from ${table}`)).rows[0].n);

test('opening stock for two products is atomic and valued from catalog prices',async()=>{
 const result=await send('Tengo 100 gorras marca X a $1500 y 100 marca Y a $1200',ops(product('X'),product('Y')));
 assert.equal(result.status,'inventory_batch_recorded');assert.equal(result.count,2);
 assert.deepEqual((await stock()).map(p=>[p.brand,p.quantity]),[['X',100],['Y',100]]);
 assert.equal(await count('inventory_movements'),2);assert.equal(await count('inventory_audit'),2);
 assert.equal((await send('¿Cuál es mi inventario en pesos?',base('inventory_value'))).sale_value_cents,'27000000');
 const movementRows=(await store.db.query('select source_message_id from inventory_movements')).rows;
 assert.ok(movementRows.every(m=>m.source_message_id===result.message_id));
});
test('sale uses quantity × explicit unit price and creates finance plus stock audits',async()=>{
 await send('Tengo 100 gorras X',product());
 const result=await send('Vendí 50 gorras X a $1500 cada una',base('inventory_sale',{product_name:'gorra',brand:'X',quantity:50,unit_price:'1500'}));
 assert.equal(result.status,'inventory_recorded');assert.match(result.text,/\$75,000\.00/);
 assert.equal((await stock())[0].quantity,50);
 assert.deepEqual((await store.db.query('select kind,amount_cents from movements')).rows,[{kind:'sale',amount_cents:7500000}]);
 assert.equal(await count('movement_audit'),1);assert.equal(await count('inventory_audit'),2);
 const linked=(await store.db.query("select i.financial_movement_id,i.source_message_id,m.id from inventory_movements i join movements m on m.id=i.financial_movement_id where i.kind='sale'")).rows[0];
 assert.equal(linked.financial_movement_id,linked.id);assert.equal(linked.source_message_id,result.message_id);
});
test('standard price is used when omitted; an explicit discount never overwrites it',async()=>{
 await send('Tengo 100 gorras X',product());
 await send('Vendí 10 gorras X',base('inventory_sale',{product_name:'gorra',brand:'X',quantity:10}));
 await send('Vendí 10 gorras X en $1400 cada una',base('inventory_sale',{product_name:'gorra',brand:'X',quantity:10,unit_price:'1400'}));
 assert.deepEqual((await store.db.query('select amount_cents from movements order by sequence')).rows.map(r=>r.amount_cents),[1500000,1400000]);
 assert.equal((await stock())[0].sale_price_cents,150000);assert.equal((await stock())[0].quantity,80);
});
test('stock entries match exactly and variants remain separate',async()=>{
 const variants=ops(
  base('opening_stock',{product_name:'sudadera',brand:'Nike',color:'negra',size:'M',quantity:5}),
  base('opening_stock',{product_name:'sudadera',brand:'Nike',color:'negra',size:'L',quantity:7}),
  base('opening_stock',{product_name:'sudadera',brand:'Nike',color:'blanca',size:'L',quantity:9}));
 assert.equal((await send('Tengo variantes de sudadera',variants)).status,'inventory_batch_recorded');
 assert.equal((await send('Agrega 20 sudaderas negras L',base('stock_in',{product_name:'sudadera',color:'negra',size:'L',quantity:20}))).status,'inventory_recorded');
 assert.equal((await send('Me llegaron sudaderas negras',base('stock_in',{product_name:'sudadera',color:'negra',quantity:2}))).reason,'inventory_ambiguous');
 assert.deepEqual((await stock()).map(p=>[p.color,p.size,p.quantity]),[['blanca','L',9],['negra','L',27],['negra','M',5]]);
 assert.equal((await send('¿Cuántas sudaderas negras talla L tengo?',base('inventory_count',{product_name:'sudadera',color:'negra',size:'L'}))).total_quantity,27);
 assert.equal(normalize(base('inventory_sale',{product_name:'sudadera',color:'negras',size:'L',quantity:2,unit_price:'900'})).color,'negra');
});
test('missing products and repeated openings never mutate stock',async()=>{
 assert.equal((await send('Me llegaron gorras X',base('stock_in',{product_name:'gorra',brand:'X',quantity:5}))).reason,'inventory_missing');
 await send('Tengo 100 gorras X',product());
 assert.equal((await send('Tengo otras 50 gorras X',product('X',{quantity:50}))).reason,'inventory_exists');
 assert.equal((await stock())[0].quantity,100);assert.equal(await count('inventory_movements'),1);
});
test('insufficient stock rejects the whole sale and leaves an idempotent clarification',async()=>{
 await send('Tengo 20 gorras X',product('X',{quantity:20}));
 const id=randomUUID(),raw=base('inventory_sale',{product_name:'gorra',brand:'X',quantity:50});
 const first=await send('Vendí 50 gorras X',raw,{externalId:id});
 assert.equal(first.reason,'stock_insufficient');assert.equal(first.available_quantity,20);assert.equal((await stock())[0].quantity,20);
 assert.equal(await count('movements'),0);assert.equal(await count('movement_audit'),0);
 const replay=await send('Vendí 50 gorras X',raw,{externalId:id});assert.equal(replay.duplicate,true);
 assert.equal(await count('inventory_movements'),1);
});
test('concurrent sales cannot consume the same units twice',async()=>{
 await send('Tengo 20 gorras X',product('X',{quantity:20}));
 const raw=base('inventory_sale',{product_name:'gorra',brand:'X',quantity:15});
 const results=await Promise.all([send('Vendí 15 gorras X',raw),send('Vendí 15 gorras X',raw)]);
 assert.equal(results.filter(r=>r.status==='inventory_recorded').length,1);
 assert.equal(results.filter(r=>r.reason==='stock_insufficient').length,1);
 assert.equal((await stock())[0].quantity,5);assert.equal(await count('movements'),1);
});
test('multiple inventory sales share one message; failure rolls back finance and stock',async()=>{
 await send('Tengo 100 gorras X y 3 sudaderas',ops(product(),base('opening_stock',{product_name:'sudadera',color:'negra',quantity:3,unit_price:'900'})));
 const mixed=ops(base('inventory_sale',{product_name:'gorra',brand:'X',quantity:5,unit_price:'1500'}),base('inventory_sale',{product_name:'sudadera',color:'negra',quantity:3,unit_price:'900'}));
 const result=await send('Vendí 5 gorras X y 3 sudaderas negras',mixed);
 assert.equal(result.status,'inventory_batch_recorded');assert.equal(await count('movements'),2);
 assert.equal(await count('movement_audit'),2);assert.equal(await count('inventory_audit'),4);
 assert.deepEqual((await store.db.query('select amount_cents from movements order by sequence')).rows.map(r=>r.amount_cents),[750000,270000]);
 const bad=ops(base('inventory_sale',{product_name:'gorra',brand:'X',quantity:5}),base('inventory_sale',{product_name:'sudadera',color:'negra',quantity:1}));
 const failure=await send('Vendí cinco gorras y una sudadera',bad);
 assert.equal(failure.reason,'stock_insufficient');assert.equal(await count('movements'),2);
 assert.deepEqual((await stock()).map(p=>p.quantity),[95,0]);
});
test('inventory sale plus a plain expense is one audited atomic batch',async()=>{
 await send('Tengo 20 gorras X',product('X',{quantity:20}));
 const result=await send('Vendí 5 gorras X y gasté $200',ops(base('inventory_sale',{product_name:'gorra',brand:'X',quantity:5}),base('expense',{amount:'200',description:'gasolina'})));
 assert.equal(result.status,'inventory_batch_recorded');
 assert.deepEqual((await store.db.query('select kind,amount_cents from movements order by sequence')).rows.map(r=>[r.kind,r.amount_cents]),[['sale',750000],['expense',20000]]);
 assert.equal((await stock())[0].quantity,15);assert.equal(await count('movement_audit'),2);
});
test('a confirmed sale deletion restores stock with a reversal and both audit trails',async()=>{
 await send('Tengo 100 gorras X',product());
 await send('Vendí 50 gorras X',base('inventory_sale',{product_name:'gorra',brand:'X',quantity:50}));
 const pending=await send('Elimina el último',base('delete_last'));assert.equal(pending.status,'confirmation');
 assert.equal((await stock())[0].quantity,50);
 const changed=await send(`CONFIRMAR ${pending.token}`,base('clarify'));assert.equal(changed.status,'changed');
 assert.equal((await stock())[0].quantity,100);
 assert.deepEqual((await store.db.query('select kind,quantity_delta from inventory_movements order by sequence')).rows.map(r=>[r.kind,Number(r.quantity_delta)]),[['opening_stock',100],['sale',-50],['reversal',50]]);
 assert.equal((await store.db.query("select count(*) as n from inventory_audit where action='reverse'")).rows[0].n,1);
 assert.equal((await store.db.query("select count(*) as n from movement_audit where action='delete_last'")).rows[0].n,1);
 assert.equal((await send('¿Cuánto vendí hoy?',base('totals',{metric:'sales'}))).sales_cents,0);
});
test('cost valuation is separate from potential sale value and missing costs stay explicit',async()=>{
 await send('Tengo gorras X',product('X',{quantity:10,unit_cost:'600'}));
 await send('Tengo gorras Y',product('Y',{quantity:5}));
 const value=await send('¿Cuánto tengo en mercancía?',base('inventory_value'));
 assert.equal(value.sale_value_cents,'2100000');assert.equal(value.cost_value_cents,'600000');
 assert.equal(value.unpriced_cost_count,5);assert.match(value.text,/Valor potencial de venta/);assert.match(value.text,/Valor registrado a costo/);
 assert.doesNotMatch(value.text,/utilidad|ganancia|valor contable/i);
});
test('inventory count, listing and top product use stored quantities',async()=>{
 await send('Tengo gorras X y Y',ops(product('X',{quantity:12}),product('Y',{quantity:30})));
 const countResult=await send('¿Cuántas gorras marca X tengo?',base('inventory_count',{product_name:'gorra',brand:'X'}));
 assert.equal(countResult.total_quantity,12);
 const top=await send('¿Qué producto tengo más?',base('inventory_top'));
 assert.equal(top.products[0].label,'gorra marca Y');assert.match(top.text,/30 piezas/);
 const list=await send('¿Qué tengo en inventario?',base('inventory_list'));
 assert.equal(list.products.length,2);
});
test('duplicate message and cross-business access cannot alter another inventory',async()=>{
 const id=randomUUID(),raw=product();await send('Tengo 100 gorras X',raw,{externalId:id});
 assert.equal((await send('Tengo 100 gorras X',raw,{externalId:id})).duplicate,true);
 assert.equal(await count('inventory_movements'),1);
 await assert.rejects(send('Tengo 200 gorras X',product('X',{quantity:200}),{externalId:id}),e=>e.status===409);
 const other=randomUUID(),otherBusiness=randomUUID();await store.seed(other,otherBusiness);
 assert.equal((await send('¿Qué tengo en inventario?',base('inventory_list'),{actor:other,business:otherBusiness})).products.length,0);
 await assert.rejects(send('¿Qué tengo en inventario?',base('inventory_list'),{actor:other}),e=>e.status===403);
 await store.db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);await store.db.exec('set role authenticated');
 try {assert.equal((await store.db.query('select * from products')).rows.length,0);assert.equal((await store.db.query('select * from inventory_movements')).rows.length,0);assert.equal((await store.db.query('select * from inventory_stock')).rows.length,0);await assert.rejects(store.db.query("select process_inventory_message($1,$2,'web','x','x','x','[]',null)",[business,other]),/permission denied/);} finally {await store.db.exec('reset role');}
});
test('audio uses the same inventory service and transcript remains attached',async()=>{
 await send('Tengo 100 gorras X',product());
 const audio=Buffer.alloc(44+32000);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(32000,40);
 const server=createServer(createHandler({store,demoUser:actor,env:{},transcriber:async()=>({text:'Me llegaron cincuenta gorras marca X.'}),interpreter:async()=>base('stock_in',{product_name:'gorra',brand:'X',quantity:50})}));
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try {const response=await fetch(`http://127.0.0.1:${server.address().port}/api/audio`,{method:'POST',headers:{'Content-Type':'audio/wav','X-CC-Business-Id':business,'X-CC-Message-Id':randomUUID()},body:audio});const result=await response.json();assert.equal(response.status,200);assert.equal(result.status,'inventory_recorded');assert.match(result.text,/Escuché: Me llegaron cincuenta/);assert.equal((await stock())[0].quantity,150);} finally {await new Promise(done=>server.close(done));}
});
test('Gemini contract exposes structured inventory facts, never a stock total to trust',()=>{
 const op=schema.properties.operations.items;
 assert.ok(op.properties.intent.enum.includes('inventory_sale'));
 for(const key of ['product_name','brand','variant','color','size','sku','unit_cost'])assert.ok(op.required.includes(key));
 assert.equal(op.properties.quantity.type[0],'string');
});
