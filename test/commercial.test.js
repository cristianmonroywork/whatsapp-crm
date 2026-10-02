import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {createLocalStore,DEMO_USER as operator,DEMO_BUSINESS as existing} from '../scripts/local-store.js';
import {handleMessage} from '../src/service.js';
import {base} from '../src/interpret.js';
import {commercialConfig,createCheckout,handleMpWebhook,verifyMpSignature,verifyMpTestSeller,resolveMpTestBuyer} from '../src/billing.js';
import {createServer} from 'node:http';
import {createHandler} from '../api/index.js';
let store,user,business;
before(async()=>{store=await createLocalStore();});after(async()=>{await store.db.close();});
beforeEach(async()=>{
 await store.db.exec('truncate businesses,profiles,auth.users cascade');await store.seed();
 user=randomUUID();await store.db.query('insert into auth.users(id,email) values($1,$2)',[user,'new@example.test']);
 business=(await store.createBusinessTrial(user,'Tienda nueva','America/Mexico_City',7)).id;
});
const send=(actor,biz,text,command)=>handleMessage({store,interpreter:async()=>command,business:biz,actor,channel:'web',externalId:randomUUID(),text});
const expire=()=>store.db.query("update business_subscriptions set current_period_start=now()-interval '8 days',current_period_end=now()-interval '1 day' where business_id=$1",[business]);
const signed=(id,secret='local-secret')=>{const ts=String(Math.floor(Date.now()/1000)),requestId='test-request';return {signature:`ts=${ts},v1=${createHmac('sha256',secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex')}`,requestId};};
async function server(handler,fn){const app=createServer(handler);await new Promise(done=>app.listen(0,'127.0.0.1',done));try{return await fn(`http://127.0.0.1:${app.address().port}`);}finally{await new Promise(done=>app.close(done));}}

test('onboarding starts one 7-day trial with owner and commercial audit',async()=>{
 const a=await store.access(user,business);assert.equal(a.status,'trialing');assert.equal(a.can_write,true);
 assert.equal((await store.db.query('select role from memberships where business_id=$1',[business])).rows[0].role,'owner');
 assert.equal((await store.db.query("select count(*)::int as n from commercial_audit where business_id=$1 and event_type='trial_started'",[business])).rows[0].n,1);
 assert.ok(new Date(a.current_period_end)>new Date(Date.now()+6*86400000));
 await assert.rejects(store.createBusinessTrial(user,'Segundo','America/Mexico_City',7),/already exists/);
 assert.equal(commercialConfig({}).priceCents,19900);
});

test('expired trial is read-only, preserves movements and rejects direct SQL writes',async()=>{
 await send(user,business,'Vendí $900',base('sale',{amount:'900'}));
 await expire();const a=await store.access(user,business);assert.equal(a.status,'expired');assert.equal(a.can_write,false);
 assert.equal((await store.db.query('select status from business_subscriptions where business_id=$1',[business])).rows[0].status,'expired');
 const q=await send(user,business,'¿Cuánto vendí hoy?',base('totals',{metric:'sales'}));assert.equal(q.sales_cents,90000);
 await assert.rejects(send(user,business,'Gasté $50',base('expense',{amount:'50'})),e=>e.status===402);
 await assert.rejects(send(user,business,'Corrige la última venta',base('correct_last',{amount:'800'})),e=>e.status===402);
 await assert.rejects(send(user,business,'Vendí 100 y gasté 20',{ambiguous:false,operations:[base('sale',{amount:'100'}),base('expense',{amount:'20'})]}),e=>e.status===402);
 const audio=await handleMessage({store,interpreter:async()=>base('totals',{metric:'sales'}),business,actor:user,channel:'web',externalId:randomUUID(),text:'¿Cuánto vendí hoy?',media:{type:'audio',transcribed:true,transcript:'¿Cuánto vendí hoy?'}});
 assert.equal(audio.sales_cents,90000);
 await assert.rejects(handleMessage({store,interpreter:async()=>base('expense',{amount:'50'}),business,actor:user,channel:'web',externalId:randomUUID(),text:'Gasté 50',media:{type:'audio',transcribed:true,transcript:'Gasté 50'}}),e=>e.status===402);
 await assert.rejects(store.db.query("insert into messages(business_id,actor_id,channel,external_id,fingerprint,content,interpretation) values($1,$2,'web',$3,'x','venta','{\"intent\":\"sale\"}'::jsonb)",[business,user,randomUUID()]),/subscription inactive/);
 assert.equal((await store.db.query('select count(*)::int as n from movements where business_id=$1',[business])).rows[0].n,1);
 assert.equal((await store.db.query("select count(*)::int as n from commercial_audit where business_id=$1 and event_type='trial_expired'",[business])).rows[0].n,1);
});

test('manual cash activation, transfer renewal, courtesy, isolation and reactivation',async()=>{
 await store.db.query('insert into pilot_operators(user_id) values($1)',[operator]);await expire();await store.access(user,business);
 await assert.rejects(store.operatorSubscriptionAction(user,{businessId:business,action:'activate',source:'manual_cash',endsAt:new Date(Date.now()+30*86400000).toISOString()}),/forbidden/);
 await assert.rejects(store.operatorSubscriptionAction(operator,{businessId:business,action:'activate',source:'manual_cash'}),/invalid expiry/);
 const first=await store.operatorSubscriptionAction(operator,{businessId:business,action:'activate',source:'manual_cash',endsAt:new Date(Date.now()+30*86400000).toISOString(),amountCents:19900,note:'Recibido fuera de Vendixa'});
 assert.equal(first.status,'active');assert.equal(first.can_write,true);
 const before=Date.parse(first.current_period_end);
 const renewed=await store.operatorSubscriptionAction(operator,{businessId:business,action:'renew',source:'manual_transfer',amountCents:19900});
 assert.ok(Date.parse(renewed.current_period_end)>before+29*86400000);
 const audit=(await store.db.query("select event_type,actor_id,before_data,after_data from commercial_audit where business_id=$1 and event_type in ('manual_activation','manual_renewal') order by created_at",[business])).rows;
 assert.deepEqual(audit.map(x=>x.event_type),['manual_activation','manual_renewal']);assert.ok(audit.every(x=>x.actor_id===operator&&x.before_data&&x.after_data));
 await store.operatorSubscriptionAction(operator,{businessId:business,action:'suspend'});assert.equal((await store.access(user,business)).can_write,false);
 await store.operatorSubscriptionAction(operator,{businessId:business,action:'activate',source:'courtesy',endsAt:new Date(Date.now()+7*86400000).toISOString()});
 assert.equal((await store.access(user,business)).can_write,true);
 await assert.rejects(store.access(operator,business),/forbidden/);
 const rows=await store.commercialDashboard(operator);assert.ok(rows.some(x=>x.id===business&&x.status==='active'));
 await assert.rejects(store.commercialDashboard(user),/forbidden/);
});

test('verified test checkout, approved webhook, duplicate and renewal are atomic',async()=>{
 const env={MP_TEST_ACCESS_TOKEN:'TEST-local-only',MP_WEBHOOK_SECRET:'local-secret',MP_TEST_BUYER_USER_ID:'123456789',MP_TEST_ALLOWED_BUSINESS_ID:business,VENDIXA_PUBLIC_URL:'https://www.vendixa.app/'};
 let attemptId,subscriptionId='subscription-test-1';
 const checkoutFetcher=async(url,options)=>{if(url==='https://api.mercadolibre.com/users/123456789')return {ok:true,json:async()=>({id:123456789})};assert.equal(url,'https://api.mercadopago.com/preapproval');assert.match(options.headers.Authorization,/TEST-/);const body=JSON.parse(options.body);attemptId=body.external_reference;assert.equal(body.auto_recurring.transaction_amount,199);assert.equal(body.payer_email,'test@testuser.com');return {ok:true,json:async()=>({id:subscriptionId,init_point:'https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_id=x'})};};
 const checkout=await createCheckout({store,actor:user,business,email:'new@example.test',env,fetcher:checkoutFetcher});
 assert.match(checkout.url,/mercadopago/);assert.equal((await store.access(user,business)).status,'trialing');
 const subscription={id:subscriptionId,external_reference:attemptId,status:'authorized',collector_id:123,auto_recurring:{currency_id:'MXN',transaction_amount:199}};
 const provider=async(url)=>{const path=new URL(url).pathname;if(path.startsWith('/preapproval/'))return {ok:true,json:async()=>subscription};if(path.startsWith('/v1/payments/')){const id=path.split('/').at(-1);return {ok:true,json:async()=>({id:Number(id),status:'approved',currency_id:'MXN',transaction_amount:199,preapproval_id:subscriptionId,date_approved:new Date().toISOString()})};}throw Error('Unexpected provider URL');};
 const deliver=async id=>{const {signature,requestId}=signed(id);return handleMpWebhook({store,query:new URLSearchParams({'data.id':id,type:'payment'}),headers:{'x-signature':signature,'x-request-id':requestId},body:{data:{id},type:'payment',live_mode:false},env,fetcher:provider});};
 assert.equal((await deliver('5001')).duplicate,false);assert.equal((await store.access(user,business)).status,'active');
 const firstEnd=Date.parse((await store.access(user,business)).current_period_end);
 assert.equal((await deliver('5001')).duplicate,true);assert.equal(Date.parse((await store.access(user,business)).current_period_end),firstEnd);
 await deliver('5002');assert.ok(Date.parse((await store.access(user,business)).current_period_end)>firstEnd);
 assert.equal((await store.db.query('select count(*)::int as n from commercial_payments where business_id=$1',[business])).rows[0].n,2);
 assert.equal((await store.db.query("select count(*)::int as n from commercial_audit where business_id=$1 and event_type='payment_approved'",[business])).rows[0].n,2);
 assert.equal((await store.db.query("select count(*)::int as n from commercial_audit where business_id=$1 and event_type in ('subscription_activated','subscription_renewed')",[business])).rows[0].n,2);
});

test('APP_USR checkout requires provider-confirmed test seller before any write',async()=>{
 const env={MP_TEST_ACCESS_TOKEN:'APP_USR-local-only',MP_WEBHOOK_SECRET:'local-secret',MP_TEST_BUYER_USER_ID:'123456789',MP_TEST_ALLOWED_BUSINESS_ID:business,VENDIXA_PUBLIC_URL:'https://www.vendixa.app/'};
 await assert.rejects(createCheckout({store,actor:user,business:randomUUID(),email:'new@example.test',env,fetcher:async()=>{throw Error('Provider must not be called');}}),e=>e.status===503);
 await assert.rejects(createCheckout({store,actor:user,business,email:'new@example.test',env:{...env,MP_TEST_BUYER_USER_ID:'invalid'},fetcher:async()=>{throw Error('Provider must not be called');}}),e=>e.status===503);
 let calls=0;
 const productionFetcher=async url=>{calls++;assert.equal(url,'https://api.mercadolibre.com/users/me');return {ok:true,json:async()=>({tags:['normal']})};};
 assert.equal(await verifyMpTestSeller({token:env.MP_TEST_ACCESS_TOKEN,fetcher:productionFetcher}),false);
 await assert.rejects(createCheckout({store,actor:user,business,email:'new@example.test',env,fetcher:productionFetcher}),e=>e.status===503);
 assert.equal(calls,2);
 assert.equal(await resolveMpTestBuyer({userId:'123456789',token:env.MP_TEST_ACCESS_TOKEN,fetcher:async()=>({ok:true,json:async()=>({id:987654321})})}),null);
 assert.equal((await store.db.query('select count(*)::int as n from checkout_attempts where business_id=$1',[business])).rows[0].n,0);
 const testFetcher=async(url,options)=>{
  if(url==='https://api.mercadolibre.com/users/me')return {ok:true,json:async()=>({tags:['normal','test_user']})};
  if(url==='https://api.mercadolibre.com/users/123456789')return {ok:true,json:async()=>({id:123456789})};
  assert.equal(url,'https://api.mercadopago.com/preapproval');assert.equal(options.headers.Authorization,`Bearer ${env.MP_TEST_ACCESS_TOKEN}`);assert.equal(JSON.parse(options.body).payer_email,'test@testuser.com');
  return {ok:true,json:async()=>({id:'sub-test',init_point:'https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_id=sub-test'})};
 };
 const checkout=await createCheckout({store,actor:user,business,email:'new@example.test',env,fetcher:testFetcher});
 assert.match(checkout.url,/sub-test/);
});

test('webhook rejects forgery, unknown binding and wrong amount',async()=>{
 assert.equal(verifyMpSignature({signature:'ts=123,v1=bad',requestId:'x',dataId:'1',secret:'local-secret'}),false);
 await assert.rejects(handleMpWebhook({store,query:new URLSearchParams({'data.id':'1',type:'payment'}),headers:{'x-signature':'bad','x-request-id':'x'},body:{data:{id:'1'},type:'payment'},env:{MP_WEBHOOK_SECRET:'local-secret'}}),e=>e.status===401);
 const a=await store.createCheckoutAttempt(user,business);await store.linkCheckoutAttempt(a.id,'sub-x','https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_id=sub-x');
 const id='222',s=signed(id);const env={MP_TEST_ACCESS_TOKEN:'TEST-local',MP_WEBHOOK_SECRET:'local-secret'};
 const provider=async url=>({ok:true,json:async()=>url.includes('/payments/')?{id:222,status:'approved',currency_id:'MXN',transaction_amount:1,preapproval_id:'sub-x'}:{id:'sub-x',external_reference:a.id,auto_recurring:{currency_id:'MXN',transaction_amount:199}}});
 const result=await handleMpWebhook({store,query:new URLSearchParams({'data.id':id,type:'payment'}),headers:{'x-signature':s.signature,'x-request-id':s.requestId},body:{data:{id},type:'payment'},env,fetcher:provider});
 assert.equal(result.ignored,true);assert.equal((await store.access(user,business)).status,'trialing');
});

test('operator migration grants confirmed account, audits roles and keeps backup until explicit revocation',async()=>{
 await store.db.query('insert into pilot_operators(user_id) values($1)',[operator]);
 const next=randomUUID();await store.db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[next,'admin@example.test']);
 await assert.rejects(store.db.query("select manage_operator_role($1,$2,'grant')",[user,next]),/forbidden/);
 await store.db.query("select manage_operator_role($1,$2,'grant')",[operator,next]);
 assert.equal((await store.db.query('select count(*)::int as n from pilot_operators')).rows[0].n,2);
 assert.equal((await store.db.query('select action,actor_id,target_id from operator_role_audit')).rows[0].actor_id,operator);
 await assert.rejects(store.db.query("select manage_operator_role($1,$2,'revoke')",[operator,operator]),/invalid operator action/);
 await store.db.query("select manage_operator_role($1,$2,'revoke')",[next,operator]);
 assert.equal((await store.db.query('select count(*)::int as n from pilot_operators')).rows[0].n,1);
 await assert.rejects(store.db.query("select manage_operator_role($1,$2,'revoke')",[operator,next]),/forbidden/);
});

test('subscription notice alone cannot activate; rejected payment, cancellation and manual expiry block writes',async()=>{
 const a=await store.createCheckoutAttempt(user,business);await store.linkCheckoutAttempt(a.id,'sub-notice','https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_id=x');
 const notice=await store.applyMpEvent({p_event_key:'subscription:sub-notice:authorized',p_topic:'subscription',p_resource_id:'sub-notice',p_attempt:a.id,p_provider_subscription:'sub-notice',p_status:'authorized',p_amount_cents:19900,p_currency:'MXN',p_paid_at:null,p_customer:null});
 assert.equal(notice.status,'trialing');
 await store.applyMpEvent({p_event_key:'payment:failed-1:rejected',p_topic:'payment',p_resource_id:'failed-1',p_attempt:a.id,p_provider_subscription:'sub-notice',p_status:'rejected',p_amount_cents:19900,p_currency:'MXN',p_paid_at:null,p_customer:null});
 assert.equal((await store.access(user,business)).status,'trialing');
 await store.applyMpEvent({p_event_key:'payment:ok-1:approved',p_topic:'payment',p_resource_id:'ok-1',p_attempt:a.id,p_provider_subscription:'sub-notice',p_status:'approved',p_amount_cents:19900,p_currency:'MXN',p_paid_at:new Date().toISOString(),p_customer:null});
 assert.equal((await store.access(user,business)).status,'active');
 await store.applyMpEvent({p_event_key:'payment:failed-2:rejected',p_topic:'payment',p_resource_id:'failed-2',p_attempt:a.id,p_provider_subscription:'sub-notice',p_status:'rejected',p_amount_cents:19900,p_currency:'MXN',p_paid_at:null,p_customer:null});
 assert.equal((await store.access(user,business)).status,'past_due');
 await store.applyMpEvent({p_event_key:'subscription:sub-notice:cancelled',p_topic:'subscription',p_resource_id:'sub-notice',p_attempt:a.id,p_provider_subscription:'sub-notice',p_status:'cancelled',p_amount_cents:19900,p_currency:'MXN',p_paid_at:null,p_customer:null});
 assert.equal((await store.access(user,business)).status,'canceled');
 await store.db.query('insert into pilot_operators(user_id) values($1)',[operator]);
 await store.operatorSubscriptionAction(operator,{businessId:business,action:'activate',source:'manual_cash',endsAt:new Date(Date.now()+86400000).toISOString()});
 await store.db.query("update business_subscriptions set current_period_end=now()-interval '1 second',current_period_start=now()-interval '2 days' where business_id=$1",[business]);
 assert.equal((await store.access(user,business)).status,'expired');
});

test('HTTP access and admin action isolate customer from operator capabilities',async()=>{
 await server(createHandler({store,demoUser:user,env:{}}),async root=>{
  const plan=await fetch(`${root}/api/plan`);assert.equal(plan.status,200);assert.equal((await plan.json()).checkout_available,false);
  const access=await fetch(`${root}/api/access?businessId=${business}`);assert.equal((await access.json()).status,'trialing');
  assert.equal((await fetch(`${root}/api/admin/subscriptions`)).status,403);
  assert.equal((await fetch(`${root}/api/admin/billing-check`)).status,403);
  assert.equal((await fetch(`${root}/api/admin/subscription-action`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businessId:business,action:'activate',source:'manual_cash'})})).status,403);
  assert.equal((await fetch(`${root}/api/access?businessId=${existing}`)).status,403);
 });
 await store.db.query('insert into pilot_operators(user_id) values($1)',[operator]);
 await server(createHandler({store,demoUser:operator,env:{}}),async root=>{
  const check=await fetch(`${root}/api/admin/billing-check`);assert.equal(check.status,200);assert.deepEqual(await check.json(),{test_token:false,token_present:false,token_has_whitespace:false,token_has_wrapping_quotes:false,test_buyer:false,test_business:false,webhook_secret:false,public_url:false});
  const result=await fetch(`${root}/api/admin/subscriptions`);assert.equal(result.status,200);assert.ok((await result.json()).businesses.some(x=>x.id===business));
  const activation=await fetch(`${root}/api/admin/subscription-action`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businessId:business,action:'activate',source:'manual_cash',endsAt:new Date(Date.now()+30*86400000).toISOString()})});
  assert.equal(activation.status,200);assert.equal((await activation.json()).status,'active');
 });
});
