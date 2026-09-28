// Opt-in HTTP test for the already-verified NEW Vercel project and an empty pilot business.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const env=process.env;
const target=new URL(env.DEPLOYMENT_URL || 'https://invalid.example');
if(env.ALLOW_DEPLOY_SMOKE!=='isolated-project'||target.protocol!=='https:'||target.hostname!==env.VERCEL_PROJECT_DOMAIN_CONFIRM||
   !env.DEPLOY_BUSINESS_ID||!env.DEPLOY_BUSINESS_NAME_CONFIRM||!env.TEST_EMAIL||!env.TEST_PASSWORD) {
  throw new Error('Deployment smoke requires an explicitly verified isolated Vercel domain, business and pilot login.');
}

async function request(path,{body,cookie}={}) {
  const response=await fetch(new URL(path,target),{method:body?'POST':'GET',redirect:'error',
    headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error(`Deployment request failed (${response.status})`);
  return {data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}

const login=await request('/api/login',{body:{email:env.TEST_EMAIL,password:env.TEST_PASSWORD}});
assert.ok(login.cookie?.startsWith('cc_session='));
const cookie=login.cookie;
const session=(await request('/api/session',{cookie})).data;
assert.equal(session.mode,'live');
assert.ok(session.businesses.some(b=>b.id===env.DEPLOY_BUSINESS_ID&&b.name===env.DEPLOY_BUSINESS_NAME_CONFIRM));
const businessId=env.DEPLOY_BUSINESS_ID;
const baseline=(await request('/api/messages',{cookie,body:{businessId,id:randomUUID(),text:'¿Cuánto vendí hoy?'}})).data;
assert.equal(baseline.sales_cents,0,'Use an empty pilot business for the exact $900 result');
const id=randomUUID();
const sale=(await request('/api/messages',{cookie,body:{businessId,id,text:'Vendí 3 playeras en $900'}})).data;
assert.equal(sale.amount_cents,90000);
const duplicate=(await request('/api/messages',{cookie,body:{businessId,id,text:'Vendí 3 playeras en $900'}})).data;
assert.equal(duplicate.duplicate,true);
const total=(await request('/api/messages',{cookie,body:{businessId,id:randomUUID(),text:'¿Cuánto vendí hoy?'}})).data;
assert.equal(total.sales_cents,90000);
console.log(JSON.stringify({passed:true,host:target.hostname,business_id:businessId,sales_cents:total.sales_cents,duplicate_prevented:true}));
