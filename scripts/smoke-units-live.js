// Opt-in, isolated integration test. Never writes to an existing business.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {SupabaseStore} from '../src/store.js';
import {interpret} from '../src/interpret.js';
import {handleMessage} from '../src/service.js';
import {validateAudio,transcribeAudio} from '../src/voice.js';

const env=process.env,ref='vixbjjjeewcjawwemvnx';
if(env.ALLOW_LIVE_SMOKE!=='isolated-project'||env.SUPABASE_PROJECT_REF_CONFIRM!==ref||
 new URL(env.SUPABASE_URL).host!==`${ref}.supabase.co`) throw new Error('Vendixa Supabase target not confirmed');
if(!env.TEST_USER_ID||!env.GEMINI_API_KEY) throw new Error('Smoke configuration incomplete');
const store=new SupabaseStore(env),actor=env.TEST_USER_ID,business=randomUUID();
await store.request('profiles?on_conflict=id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({id:actor,display_name:'Prueba Vendixa'})});
await store.request('businesses',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({id:business,name:`Smoke Unidades 5.7.1 ${new Date().toISOString()}`,timezone:'America/Mexico_City'})});
await store.request('memberships',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({business_id:business,user_id:actor})});
const send=(text,id=randomUUID(),media=null)=>handleMessage({store,interpreter:interpret,actor,business,channel:'web',externalId:id,text,media});
const opening=await send('Compré 10 toneladas de jitomate a $18 el kilo.');
assert.equal(opening.status,'inventory_recorded');assert.equal(opening.operations[0].base_quantity,10000);
const saleId=randomUUID(),sale=await send('Vendí 350 kilos de jitomate a $28 el kilo.',saleId);
assert.equal(sale.status,'inventory_recorded');assert.equal(sale.operations[0].amount_cents,980000);
assert.equal((await send('Vendí 350 kilos de jitomate a $28 el kilo.',saleId)).duplicate,true);
const tonnes=await send('¿Cuántas toneladas de jitomate me quedan?');
assert.equal(tonnes.status,'inventory_count');assert.equal(Number(tonnes.total_quantity),9.65);
const value=await send('¿Cuál es el valor potencial de venta del inventario?');
assert.equal(value.sale_value_cents,'27020000');
const watches=await send('Tengo 10 Rolex Submariner a $220,000 cada uno y 5 Cartier Santos a $145,000.');
assert.equal(watches.status,'inventory_batch_recorded');
const watchSale=await send('Vendí un Rolex Submariner en $215,000.');
assert.equal(watchSale.status,'inventory_recorded');assert.equal(watchSale.operations[0].amount_cents,21500000);
const boxes=await send('Tengo 20 cajas de agua.');
assert.equal(boxes.status,'inventory_recorded');
const boxSale=await send('Vendí 3 cajas.');
assert.equal(boxSale.status,'inventory_recorded');assert.equal(boxSale.operations[0].kind,'sale_unpriced');
assert.equal(boxSale.operations[0].amount_cents,null);
assert.match(boxSale.text,/No sumé una venta en dinero/);
let voice=null;
if(env.INVENTORY_UNITS_VOICE_FILE){
 const bytes=await readFile(env.INVENTORY_UNITS_VOICE_FILE),details=await validateAudio(bytes,'audio/wav');
 const transcription=await transcribeAudio(bytes,{mime:details.mime,key:env.GEMINI_API_KEY,model:env.GEMINI_TRANSCRIBE_MODEL||env.GEMINI_MODEL});
 const transcript=transcription.text?.trim();assert.ok(transcript);
 voice=await send(transcript,randomUUID(),{type:'audio',origin:'web',...details,sha256:createHash('sha256').update(bytes).digest('hex'),transcribed:true,transcript});
 assert.equal(voice.status,'inventory_recorded');assert.equal(voice.operations[0].amount_cents,65800);
}
const stock=await store.request(`inventory_stock?business_id=eq.${business}&select=name,quantity,base_unit`);
const tomato=stock.find(p=>p.name==='jitomate'),rolex=stock.find(p=>p.name==='Rolex Submariner'),cartier=stock.find(p=>p.name==='Cartier Santos'),water=stock.find(p=>p.name==='agua');
assert.equal(Number(tomato.quantity),voice?9626.5:9650);assert.equal(tomato.base_unit,'kg');
assert.equal(Number(rolex.quantity),9);assert.equal(Number(cartier.quantity),5);
assert.equal(Number(water.quantity),17);assert.equal(water.base_unit,'caja');
const messages=await store.request(`messages?business_id=eq.${business}&select=id,external_id,media,response`);
const inventory=await store.request(`inventory_movements?business_id=eq.${business}&select=id,source_message_id,original_quantity,original_unit,quantity_delta,base_unit,calculated_amount_cents`);
const audits=await store.request(`inventory_audit?business_id=eq.${business}&select=inventory_movement_id,message_id`);
const finance=await store.request(`movements?business_id=eq.${business}&select=id,amount_cents,source_message_id`);
assert.equal(messages.filter(m=>m.external_id===saleId).length,1);
assert.equal(inventory.length,audits.length);assert.equal(finance.length,voice?3:2);
assert.ok(inventory.every(i=>audits.some(a=>a.inventory_movement_id===i.id&&a.message_id===i.source_message_id)));
console.log(JSON.stringify({passed:true,project:ref,business_id:business,stock_kg:tomato.quantity,sale_cents:sale.operations[0].amount_cents,
 potential_sale_value_cents:value.sale_value_cents,rolex:rolex.quantity,cartier:cartier.quantity,water_boxes:water.quantity,voice:!!voice,
 messages:messages.length,inventory_movements:inventory.length,inventory_audits:audits.length,financial_movements:finance.length},null,2));
