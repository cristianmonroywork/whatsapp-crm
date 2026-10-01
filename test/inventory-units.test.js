import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalStore,DEMO_USER as actor,DEMO_BUSINESS as business} from '../scripts/local-store.js';
import {handleMessage} from '../src/service.js';
import {base,interpret} from '../src/interpret.js';
import {normalize} from '../src/domain.js';

let store;
before(async()=>{store=await createLocalStore();});
after(async()=>{await store.db.close();});
beforeEach(async()=>{await store.db.exec('truncate businesses,profiles,auth.users cascade');await store.seed();});
const ops=(...operations)=>({ambiguous:false,operations});
const send=(text,raw,extra={})=>handleMessage({store,interpreter:async()=>raw,business,actor,channel:'web',externalId:randomUUID(),text,...extra});
const tomato=(extra={})=>base('opening_stock',{product_name:'jitomate',quantity:'10',unit:'tonelada',unit_cost:'18',cost_unit:'kg',...extra});
const stock=async name=>(await store.db.query('select quantity,base_unit,sale_price_base_cents,cost_price_base_cents from inventory_stock where name=$1',[name])).rows[0];
const count=async table=>Number((await store.db.query(`select count(*) as n from ${table}`)).rows[0].n);

test('10 toneladas at cost per kg, 350 kg sale, stock, value and full audit',async()=>{
 const opening=await send('Compré 10 toneladas de jitomate a $18 el kilo',tomato());
 assert.equal(opening.status,'inventory_recorded');assert.equal(opening.operations[0].base_quantity,10000);
 assert.equal((await stock('jitomate')).base_unit,'kg');assert.equal((await stock('jitomate')).cost_price_base_cents,'1800.000000');
 const sale=await send('Vendí 350 kilos de jitomate a $28 el kilo',base('inventory_sale',{product_name:'jitomate',quantity:'350',unit:'kg',unit_price:'28',price_unit:'kg'}));
 assert.equal(sale.status,'inventory_recorded');assert.equal(sale.operations[0].amount_cents,980000);
 assert.equal(Number((await stock('jitomate')).quantity),9650);
 const tonnes=await send('¿Cuántas toneladas de jitomate me quedan?',base('inventory_count',{product_name:'jitomate',unit:'tonelada'}));
 assert.equal(Number(tonnes.total_quantity),9.65);assert.match(tonnes.text,/9\.65 toneladas/);
 const kilograms=await send('¿Cuántos kilos de jitomate me quedan?',base('inventory_count',{product_name:'jitomate',unit:'kg'}));
 assert.equal(Number(kilograms.total_quantity),9650);
 const value=await send('¿Cuál es el valor potencial de venta del inventario?',base('inventory_value',{unit:null}));
 assert.equal(value.sale_value_cents,'27020000');assert.equal(value.cost_value_cents,'17370000');
 const rows=(await store.db.query('select original_quantity,original_unit,quantity_delta,base_unit,original_price_cents,original_price_unit,calculated_amount_cents from inventory_movements order by sequence')).rows;
 assert.deepEqual(rows.map(r=>[Number(r.original_quantity),r.original_unit,Number(r.quantity_delta),r.base_unit,r.original_price_cents,r.original_price_unit,r.calculated_amount_cents]),
  [[10,'tonelada',10000,'kg',1800,'kg',null],[350,'kg',-350,'kg',2800,'kg',980000]]);
 const rates=(await store.db.query('select original_sale_price_cents,original_sale_price_unit,original_cost_cents,original_cost_unit from inventory_movements order by sequence')).rows;
 assert.deepEqual(rates.map(r=>[r.original_sale_price_cents,r.original_sale_price_unit,r.original_cost_cents,r.original_cost_unit]),
  [[null,null,1800,'kg'],[2800,'kg',null,null]]);
 assert.equal(await count('inventory_audit'),2);assert.equal(await count('movement_audit'),1);
});

test('half a tonne, grams and decimal kilos convert exactly',async()=>{
 await send('Tengo jitomate',tomato());
 const half=await send('Vendí media tonelada de jitomate',base('inventory_sale',{product_name:'jitomate',quantity:'0.5',unit:'tonelada',unit_price:'28000',price_unit:'tonelada'}));
 assert.equal(half.operations[0].base_quantity,500);assert.equal(half.operations[0].amount_cents,1400000);
 await send('Llegaron 750 gramos',base('stock_in',{product_name:'jitomate',quantity:'750',unit:'g'}));
 assert.equal(Number((await stock('jitomate')).quantity),9500.75);
 const decimal=await send('Vendí 23.7 kg de jitomate a $28/kg',base('inventory_sale',{product_name:'jitomate',quantity:'23.7',unit:'kg',unit_price:'28',price_unit:'kg'}));
 assert.equal(decimal.operations[0].amount_cents,66360);assert.equal(Number((await stock('jitomate')).quantity),9477.05);
});

test('litres and millilitres keep decimal stock and price per litre',async()=>{
 await send('Me llegaron 25 litros de aceite',base('opening_stock',{product_name:'aceite',quantity:'25',unit:'litro',unit_price:'40',price_unit:'litro'}));
 const sale=await send('Vendí 1.5 litros de aceite',base('inventory_sale',{product_name:'aceite',quantity:'1.5',unit:'litro'}));
 assert.equal(sale.operations[0].amount_cents,6000);assert.equal(Number((await stock('aceite')).quantity),23.5);
 await send('Me llegaron 250 ml de aceite',base('stock_in',{product_name:'aceite',quantity:'250',unit:'ml'}));
 const ml=await send('¿Cuántos ml de aceite quedan?',base('inventory_count',{product_name:'aceite',unit:'ml'}));
 assert.equal(Number(ml.total_quantity),23750);assert.equal(Number((await stock('aceite')).quantity),23.75);
});

test('cartons remain cartons, never inferred bottles; piece inventory survives',async()=>{
 await send('Tengo 20 cajas de agua',base('opening_stock',{product_name:'agua',quantity:'20',unit:'caja'}));
 await send('Vendí 3 cajas',base('inventory_sale',{product_name:'agua',quantity:'3',unit:'caja',unit_price:'120',price_unit:'caja'}));
 assert.equal(Number((await stock('agua')).quantity),17);
 const bottles=await send('Vendí 2 piezas de agua',base('inventory_sale',{product_name:'agua',quantity:'2',unit:'pieza',unit_price:'10',price_unit:'pieza'}));
 assert.equal(bottles.status,'clarify');assert.equal(Number((await stock('agua')).quantity),17);
 await send('Tengo 10 Rolex y 5 Cartier',ops(base('opening_stock',{product_name:'Rolex Submariner',quantity:'10',unit:'pieza',unit_price:'220000'}),base('opening_stock',{product_name:'Cartier Santos',quantity:'5',unit:'pieza',unit_price:'145000'})));
 const watch=await send('Vendí un Rolex en 215 mil',base('inventory_sale',{product_name:'Rolex Submariner',quantity:'1',unit:'pieza',unit_price:'215000'}));
 assert.equal(watch.operations[0].amount_cents,21500000);assert.equal(Number((await stock('Rolex Submariner')).quantity),9);
 assert.equal(Number((await stock('Cartier Santos')).quantity),5);
});

test('variants and packages are isolated; no implicit costal conversion',async()=>{
 await send('Tengo saladette y bola',ops(tomato({quantity:'25',unit:'kg',variant:'saladette'}),tomato({quantity:'20',unit:'kg',variant:'bola'})));
 await send('Vendí 3 kilos saladette',base('inventory_sale',{product_name:'jitomate',variant:'saladette',quantity:'3',unit:'kg',unit_price:'28',price_unit:'kg'}));
 const rows=(await store.db.query('select variant,quantity from inventory_stock order by variant')).rows;
 assert.deepEqual(rows.map(r=>[r.variant,Number(r.quantity)]),[['bola',20],['saladette',22]]);
 await send('Tengo costales de jitomate',base('opening_stock',{product_name:'jitomate',variant:'en costal',quantity:'4',unit:'costal'}));
 const bad=await send('Vendí 25 kg del costal',base('inventory_sale',{product_name:'jitomate',variant:'en costal',quantity:'25',unit:'kg',unit_price:'28',price_unit:'kg'}));
 assert.equal(bad.status,'clarify');assert.equal(Number((await store.db.query("select quantity from inventory_stock where variant='en costal'")).rows[0].quantity),4);
});

test('all-or-nothing decimal batch, idempotency and rollback',async()=>{
 await send('Tengo jitomate',tomato());
 await send('Tengo chile',base('opening_stock',{product_name:'chile',quantity:'200',unit:'kg',unit_price:'35',price_unit:'kg'}));
 const id=randomUUID(),raw=ops(base('inventory_sale',{product_name:'jitomate',quantity:'350',unit:'kg',unit_price:'28',price_unit:'kg'}),base('inventory_sale',{product_name:'chile',quantity:'200',unit:'kg',unit_price:'35',price_unit:'kg'}));
 const good=await send('Vendí jitomate y chile',raw,{externalId:id});assert.equal(good.status,'inventory_batch_recorded');
 assert.equal((await send('Vendí jitomate y chile',raw,{externalId:id})).duplicate,true);
 assert.equal(await count('movements'),2);assert.equal(Number((await stock('jitomate')).quantity),9650);assert.equal(Number((await stock('chile')).quantity),0);
 const bad=await send('Vendí más jitomate y chile',ops(base('inventory_sale',{product_name:'jitomate',quantity:'1.5',unit:'kg',unit_price:'28',price_unit:'kg'}),base('inventory_sale',{product_name:'chile',quantity:'1',unit:'kg',unit_price:'35',price_unit:'kg'})));
 assert.equal(bad.reason,'stock_insufficient');assert.equal(Number((await stock('jitomate')).quantity),9650);assert.equal(await count('movements'),2);
});

test('voice decimal uses identical service, deletion reverses normalized units',async()=>{
 await send('Tengo jitomate',tomato());
 const speech='Vendí veintitrés punto cinco kilos de jitomate a veintiocho pesos el kilo';
 const raw=base('inventory_sale',{product_name:'jitomate',quantity:'23.5',unit:'kg',unit_price:'28',price_unit:'kg'});
 const sale=await send(speech,raw,{media:{type:'audio',origin:'web',transcribed:true,transcript:speech,sha256:'a'.repeat(64)}});
 assert.equal(sale.operations[0].amount_cents,65800);assert.match(sale.text,/Escuché:/);
 const pending=await send('Elimina el último',base('delete_last'));assert.equal(pending.status,'confirmation');
 await send(`CONFIRMAR ${pending.token}`,base('clarify'));
 assert.equal(Number((await stock('jitomate')).quantity),10000);
 const reverse=(await store.db.query("select quantity_delta,original_quantity,original_unit,base_unit from inventory_movements where kind='reversal'")).rows[0];
 assert.deepEqual([Number(reverse.quantity_delta),Number(reverse.original_quantity),reverse.original_unit,reverse.base_unit],[23.5,23.5,'kg','kg']);
});

test('unknown unit requests clarification; existing product resolves omitted unit',async()=>{
 const unknown=await send('Compré 10 jitomates',base('opening_stock',{product_name:'jitomate',quantity:'10',unit:null}));
 assert.equal(unknown.reason,'inventory_unit_required');assert.equal(await count('products'),0);
 await send('Tengo jitomate por kilos',tomato());
 const existing=await send('Compré 10 jitomates',base('opening_stock',{product_name:'jitomate',quantity:'10',unit:null}));
 assert.equal(existing.status,'inventory_recorded');assert.equal(Number((await stock('jitomate')).quantity),10010);
 assert.equal(normalize(base('opening_stock',{product_name:'jitomate',quantity:'1.25',unit:'kilos'})).unit,'kg');
 assert.equal(normalize(base('opening_stock',{product_name:'jitomate',quantity:'1.1234567',unit:'kg'})).intent,'clarify');
});

test('another business cannot query or change inventory',async()=>{
 await send('Tengo jitomate',tomato());
 const other=randomUUID();await store.seed(actor,other,'Otro negocio');
 const result=await send('¿Cuántos kg de jitomate?',base('inventory_count',{product_name:'jitomate',unit:'kg'}),{business:other});
 assert.equal(result.status,'inventory_count');assert.equal(result.products.length,0);
 assert.equal(Number((await stock('jitomate')).quantity),10000);
});

test('pieces remain whole and dozens convert only for an existing piece product',async()=>{
 const unknown=await send('Tengo 2 docenas de gorras',base('opening_stock',{product_name:'gorra',quantity:'2',unit:'docena'}));
 assert.equal(unknown.reason,'inventory_unit_required');
 await send('Tengo 24 gorras',base('opening_stock',{product_name:'gorra',quantity:'24',unit:'pieza',unit_price:'10'}));
 const dozens=await send('Me llegaron dos docenas',base('stock_in',{product_name:'gorra',quantity:'2',unit:'docena'}));
 assert.equal(dozens.operations[0].base_quantity,24);assert.equal(Number((await stock('gorra')).quantity),48);
 const fraction=await send('Vendí media gorra',base('inventory_sale',{product_name:'gorra',quantity:'0.5',unit:'pieza',unit_price:'10'}));
 assert.equal(fraction.reason,'inventory_unit_incompatible');assert.equal(Number((await stock('gorra')).quantity),48);
 const countDozens=await send('¿Cuántas docenas?',base('inventory_count',{product_name:'gorra',unit:'docena'}));
 assert.equal(Number(countDozens.total_quantity),4);
 await send('Vendí una gorra',base('inventory_sale',{product_name:'gorra',quantity:'1',unit:'pieza'}));
 const notExact=await send('¿Cuántas docenas?',base('inventory_count',{product_name:'gorra',unit:'docena'}));
 assert.equal(notExact.reason,'inventory_unit_incompatible');
});

test('unit price ratio stays exact for a million pieces',async()=>{
 await send('Tengo un millón de piezas',base('opening_stock',{product_name:'tornillo',quantity:'1000000',unit:'pieza',unit_price:'1',price_unit:'docena'}));
 const sale=await send('Vendí un millón',base('inventory_sale',{product_name:'tornillo',quantity:'1000000',unit:'pieza'}));
 assert.equal(sale.operations[0].amount_cents,8333333);assert.equal(Number((await stock('tornillo')).quantity),0);
});

test('Gemini adapter keeps financial query metrics while routing explicit measured sales',async()=>{
 const fake=operation=>async()=>({ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({ambiguous:false,operations:[operation]})}]}}]})});
 const query=await interpret('¿Cuánto vendí hoy?',{key:'fake',model:'gemini-test',fetcher:fake(base('totals',{description:'sales'}))});
 assert.equal(query.operations[0].metric,'sales');assert.equal(normalize(query.operations[0]).intent,'totals');
 const measured=await interpret('Vendí 1.5 litros de aceite',{key:'fake',model:'gemini-test',fetcher:fake(base('sale',{product_name:'aceite',quantity:'1.5',unit:'litro'}))});
 assert.equal(measured.operations[0].intent,'inventory_sale');
 const range=await interpret('¿Cuánto vendí del 1 al 5?',{key:'fake',model:'gemini-test',fetcher:fake(base('totals',{description:'sales',period:'range',date:'2026-09-01..2026-09-05'}))});
 assert.equal(range.operations[0].from_date,'2026-09-01');assert.equal(range.operations[0].to_date,'2026-09-05');
});
