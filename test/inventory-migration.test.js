import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('migration 006 preserves existing piece stock, prices, audit and linked sale history',async()=>{
 const db=new PGlite();await db.waitReady;
 try{
  await db.exec(`create schema auth;
   create role anon;create role authenticated;create role service_role bypassrls;
   create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
   grant usage on schema public,auth to anon,authenticated,service_role;
   grant execute on function auth.uid() to authenticated;`);
  for(const file of ['001_initial.sql','002_batches.sql','003_queries.sql','004_pilot.sql','005_inventory.sql'])
   await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
  const actor='11111111-1111-4111-8111-111111111111',business='22222222-2222-4222-8222-222222222222';
  await db.query('insert into auth.users(id) values($1)',[actor]);
  await db.query('insert into profiles(id) values($1)',[actor]);
  await db.query("insert into businesses(id,name,timezone) values($1,'Negocio anterior','America/Mexico_City')",[business]);
  await db.query('insert into memberships(business_id,user_id) values($1,$2)',[business,actor]);
  const old=async(id,command)=>(await db.query('select process_inventory_message($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) as result',
   [business,actor,'web',id,`fingerprint-${id}`,id,JSON.stringify([command]),null])).rows[0].result;
  assert.equal((await old('old-opening',{intent:'opening_stock',date:'today',product_name:'gorra',brand:'X',quantity:100,unit_price_cents:150000})).status,'inventory_recorded');
  assert.equal((await old('old-sale',{intent:'inventory_sale',date:'today',product_name:'gorra',brand:'X',quantity:2,unit_price_cents:150000})).status,'inventory_recorded');
  const before=(await db.query('select quantity from inventory_stock')).rows[0].quantity;
  await db.exec(await readFile(new URL('../supabase/migrations/006_inventory_units.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/007_unpriced_stock_sales.sql',import.meta.url),'utf8'));
  const after=(await db.query('select quantity,base_unit,sale_price_original_cents,sale_price_unit from inventory_stock')).rows[0];
  assert.equal(Number(after.quantity),before);assert.equal(after.base_unit,'pieza');
  assert.equal(after.sale_price_original_cents,150000);assert.equal(after.sale_price_unit,'pieza');
  const movements=(await db.query('select original_quantity,original_unit,base_unit from inventory_movements order by sequence')).rows;
  assert.deepEqual(movements.map(m=>[Number(m.original_quantity),m.original_unit,m.base_unit]),[[100,'pieza','pieza'],[2,'pieza','pieza']]);
  assert.equal((await db.query('select count(*) as n from inventory_audit')).rows[0].n,2);
  const newer=(await db.query('select process_inventory_message($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) as result',
   [business,actor,'web','new-sale','fingerprint-new-sale','new-sale',JSON.stringify([{intent:'inventory_sale',date:'today',product_name:'gorra',brand:'X',quantity:'3',unit:'pieza'}]),null])).rows[0].result;
  assert.equal(newer.status,'inventory_recorded');assert.equal(newer.operations[0].amount_cents,450000);
  assert.equal(Number((await db.query('select quantity from inventory_stock')).rows[0].quantity),95);
  const legacyDuringDeploy=await old('legacy-opening',{intent:'opening_stock',date:'today',product_name:'Cartier Santos',quantity:5,unit_price_cents:14500000});
  assert.equal(legacyDuringDeploy.status,'inventory_recorded');
  assert.equal((await db.query("select base_unit from products where name='Cartier Santos'")).rows[0].base_unit,'pieza');
 }finally{await db.close();}
});
