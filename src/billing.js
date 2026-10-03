import {createHmac,timingSafeEqual} from 'node:crypto';

const mpBase='https://api.mercadopago.com';
const testToken=token=>typeof token==='string'&&/^(?:TEST-|APP_USR-)/.test(token);
export const testBuyerId=env=>/^\d{5,20}$/.test(env.MP_TEST_BUYER_USER_ID||'')?env.MP_TEST_BUYER_USER_ID:null;
export const testBuyerEmail=env=>/^[a-z0-9._+-]{3,120}@testuser\.com$/i.test(env.MP_TEST_BUYER_EMAIL||'')?env.MP_TEST_BUYER_EMAIL:null;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function commercialConfig(env=process.env){
 const trialDays=Number(env.VENDIXA_TRIAL_DAYS||7),price=Number(env.VENDIXA_PLAN_PRICE_MXN||199);
 if(!Number.isInteger(trialDays)||trialDays<1||trialDays>30||!Number.isInteger(price)||price<1||price>100000) throw new Error('Invalid commercial plan configuration');
 return {plan:'vendixa_monthly',trialDays,priceCents:price*100,currency:'MXN',period:'month'};
}
export function canWrite(access){return access?.can_write===true;}
export function isReadIntent(command){
 return ['totals','balance','debtors','summary','comparison','best_day','business_overview','inventory_list','inventory_count','inventory_value','inventory_top'].includes(command?.intent)
  || command?.intent==='inventory_batch'&&command.operations?.length===1&&isReadIntent(command.operations[0]);
}
export function verifyMpSignature({signature,requestId,dataId,secret,now=Date.now()}){
 if(!signature||!requestId||!dataId||!secret||!/^[-\w]{1,160}$/.test(String(requestId))||!/^[-\w]{1,160}$/.test(String(dataId)))return false;
 const values=Object.fromEntries(String(signature).split(',').map(part=>part.trim().split('=',2)));
 if(!/^\d{10,13}$/.test(values.ts||'')||!/^[a-f0-9]{64}$/i.test(values.v1||''))return false;
 const timestamp=Number(values.ts)*(values.ts.length===10?1000:1);
 if(Math.abs(now-timestamp)>5*60*1000)return false;
 const manifest=`id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${values.ts};`;
 const expected=createHmac('sha256',secret).update(manifest).digest('hex');
 return timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(values.v1,'hex'));
}
export async function mpRequest(path,{token,method='GET',body,fetcher=fetch}={}){
 if(!testToken(token))throw new Error('Mercado Pago credential format is invalid');
 const response=await fetcher(`${mpBase}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Object.assign(new Error('Mercado Pago request failed'),{status:503});
 return response.json();
}
export async function verifyMpTestSeller({token,fetcher=fetch}){
 if(!testToken(token))return false;
 if(token.startsWith('TEST-'))return true;
 const response=await fetcher('https://api.mercadolibre.com/users/me',{
  headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)
 });
 if(!response.ok)return false;
 const seller=await response.json();
 return Array.isArray(seller.tags)&&seller.tags.includes('test_user');
}
export async function resolveMpTestBuyer({userId,email,token,fetcher=fetch}){
 if(!/^\d{5,20}$/.test(userId||'')||!/^[a-z0-9._+-]{3,120}@testuser\.com$/i.test(email||'')||!testToken(token))return null;
 const response=await fetcher(`https://api.mercadolibre.com/users/${userId}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
 if(!response.ok)return null;
 const buyer=await response.json();
 // Mercado Pago no expone el correo de una cuenta Comprador cuando se consulta
 // con el token del Vendedor. Ambos valores se obtienen del panel/cuenta de
 // prueba y permanecen exclusivamente como configuración server-side.
 if(String(buyer.id)!==userId)return null;
 return email;
}
export async function createCheckout({store,actor,business,email,env=process.env,fetcher=fetch}){
 const config=commercialConfig(env);
 if(!env.MP_TEST_ACCESS_TOKEN||!env.MP_WEBHOOK_SECRET||!/^https:\/\//.test(env.VENDIXA_PUBLIC_URL||''))throw Object.assign(new Error('Checkout unavailable'),{status:503});
 if(!uuid.test(env.MP_TEST_ALLOWED_BUSINESS_ID||'')||business!==env.MP_TEST_ALLOWED_BUSINESS_ID||!testBuyerId(env)||!testBuyerEmail(env))throw Object.assign(new Error('Test checkout unavailable for this business'),{status:503});
 if(!await verifyMpTestSeller({token:env.MP_TEST_ACCESS_TOKEN,fetcher}))throw Object.assign(new Error('Test seller verification failed'),{status:503});
 const buyerEmail=await resolveMpTestBuyer({userId:testBuyerId(env),email:testBuyerEmail(env),token:env.MP_TEST_ACCESS_TOKEN,fetcher});
 if(!buyerEmail)throw Object.assign(new Error('Test buyer verification failed'),{status:503});
 const attempt=await store.createCheckoutAttempt(actor,business);
 if(attempt.url)return {url:attempt.url,plan:config.plan,price_cents:config.priceCents,currency:'MXN'};
 const response=await mpRequest('/preapproval',{token:env.MP_TEST_ACCESS_TOKEN,method:'POST',fetcher,body:{reason:'Vendixa mensual',external_reference:attempt.id,payer_email:buyerEmail,
  auto_recurring:{frequency:1,frequency_type:'months',transaction_amount:config.priceCents/100,currency_id:'MXN'},
  back_url:env.VENDIXA_PUBLIC_URL,status:'pending'}});
 if(!response.id||!/^https:\/\/(?:www\.)?mercadopago\.com\.mx\//.test(response.init_point||''))throw Object.assign(new Error('Invalid checkout response'),{status:503});
 await store.linkCheckoutAttempt(attempt.id,String(response.id),response.init_point);
 await store.event(actor,business,'checkout_started');
 return {url:response.init_point,plan:config.plan,price_cents:config.priceCents,currency:'MXN'};
}
const cents=value=>{const n=Number(value);return Number.isFinite(n)&&n>=0&&Number.isInteger(n*100)?n*100:null;};
export async function handleMpWebhook({store,query,headers,body,env=process.env,fetcher=fetch}){
 const dataId=query.get('data.id')||body?.data?.id;
 if(String(body?.data?.id||'')!==String(dataId||'')||!verifyMpSignature({signature:headers['x-signature'],requestId:headers['x-request-id'],dataId,secret:env.MP_WEBHOOK_SECRET}))
  throw Object.assign(new Error('Invalid Mercado Pago signature'),{status:401});
 const type=query.get('type')||body?.type;
 if(!['payment','subscription_preapproval','subscription_authorized_payment'].includes(type))return {ignored:true};
 if(!/^[-\w]{1,160}$/.test(String(dataId)))throw Object.assign(new Error('Invalid provider resource'),{status:400});
 if(!env.MP_TEST_ACCESS_TOKEN)throw Object.assign(new Error('Checkout unavailable'),{status:503});
 if(!await verifyMpTestSeller({token:env.MP_TEST_ACCESS_TOKEN,fetcher}))throw Object.assign(new Error('Test seller verification failed'),{status:503});
 let resource,topic,providerSubscription,paymentId=String(dataId);
 if(type==='payment'){
  resource=await mpRequest(`/v1/payments/${encodeURIComponent(dataId)}`,{token:env.MP_TEST_ACCESS_TOKEN,fetcher});
  topic='payment';providerSubscription=resource.metadata?.preapproval_id||resource.point_of_interaction?.transaction_data?.subscription_id||resource.preapproval_id;
 }else if(type==='subscription_authorized_payment'){
  resource=await mpRequest(`/authorized_payments/${encodeURIComponent(dataId)}`,{token:env.MP_TEST_ACCESS_TOKEN,fetcher});
  topic='authorized_payment';providerSubscription=resource.preapproval_id;
  if(!resource.payment?.id)return {ignored:true};
  const payment=await mpRequest(`/v1/payments/${encodeURIComponent(resource.payment.id)}`,{token:env.MP_TEST_ACCESS_TOKEN,fetcher});
  if(String(payment.id)!==String(resource.payment.id)||payment.currency_id!==resource.currency_id||cents(payment.transaction_amount)!==cents(resource.transaction_amount))return {ignored:true};
  paymentId=String(payment.id);resource={...resource,status:payment.status,date_approved:payment.date_approved};
 }else{
  resource=await mpRequest(`/preapproval/${encodeURIComponent(dataId)}`,{token:env.MP_TEST_ACCESS_TOKEN,fetcher});
  topic='subscription';providerSubscription=String(dataId);
 }
 if(String(resource.id)!==String(dataId)||!providerSubscription)return {ignored:true};
 const subscription=type==='subscription_preapproval'?resource:await mpRequest(`/preapproval/${encodeURIComponent(providerSubscription)}`,{token:env.MP_TEST_ACCESS_TOKEN,fetcher});
 if(resource.live_mode===true||subscription.live_mode===true)return {ignored:true};
 if(String(subscription.id)!==String(providerSubscription)||!uuid.test(String(subscription.external_reference||'')))return {ignored:true};
 if(topic!=='subscription'&&subscription.status!=='authorized')return {ignored:true};
 const attempt=await store.checkoutAttempt(subscription.external_reference);
 if(!attempt||attempt.provider_subscription_id&&attempt.provider_subscription_id!==String(providerSubscription))return {ignored:true};
 if(env.MP_EXPECTED_COLLECTOR_ID&&String(subscription.collector_id)!==String(env.MP_EXPECTED_COLLECTOR_ID))return {ignored:true};
 if(subscription.auto_recurring?.currency_id!=='MXN'||cents(subscription.auto_recurring?.transaction_amount)!==commercialConfig(env).priceCents)return {ignored:true};
 const status=topic==='subscription'?({authorized:'authorized',paused:'paused',cancelled:'cancelled',canceled:'cancelled',pending:'pending'}[subscription.status]||'pending'):
  ({approved:'approved',rejected:'rejected',pending:'pending'}[resource.status]||'pending');
 if(topic!=='subscription'&&cents(resource.transaction_amount??resource.transaction_amount_refunded??resource.amount)!==commercialConfig(env).priceCents)return {ignored:true};
 const eventKey=`${topic}:${paymentId}:${status}`;
 return store.applyMpEvent({p_event_key:eventKey,p_topic:topic,p_resource_id:paymentId,p_attempt:attempt.id,
  p_provider_subscription:String(providerSubscription),p_status:status,p_amount_cents:topic==='subscription'?commercialConfig(env).priceCents:cents(resource.transaction_amount??resource.amount),
  p_currency:resource.currency_id||subscription.auto_recurring.currency_id,p_paid_at:resource.date_approved||resource.date_last_updated||null,
  p_customer:subscription.payer_id?String(subscription.payer_id):null});
}
