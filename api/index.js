import {SupabaseStore} from '../src/store.js';
import {interpret} from '../src/interpret.js';
import {handleMessage,messageFingerprint} from '../src/service.js';
import {MAX_AUDIO_BYTES,validateAudio,transcribeAudio} from '../src/voice.js';
import {validSignature,receiveWhatsApp} from '../src/whatsapp.js';
import {commercialConfig,createCheckout,handleMpWebhook,verifyMpTestSeller,testBuyerId,resolveMpTestBuyer} from '../src/billing.js';

export async function readBody(req,limit=65536) {
  let length=0;const chunks=[];
  for await(const chunk of req) {length+=Buffer.byteLength(chunk);if(length>limit) throw Object.assign(new Error('Mensaje demasiado grande.'),{status:413});chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks);
}
function reply(res,status,body) {res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));}
function cookie(req,name) {return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1);}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limit=(value,fallback,max)=>{const n=Number(value);return Number.isInteger(n)&&n>0&&n<=max?n:fallback;};
async function touch(store,actor,business) {try {await store.presence?.(actor,business);} catch {}}
function friendlyError(error,status) {
 if(['El audio está vacío.','El audio supera 3 MB.','El audio supera 60 segundos.','No pude leer el audio.','Envía sólo audio.','No pude comprobar la duración del audio.'].includes(error?.message))return error.message;
 if(status===401)return 'Tu sesión venció o las credenciales son incorrectas. Entra de nuevo.';
 if(status===402)return 'Tu acceso venció. Tus datos siguen disponibles. Activa Vendixa para continuar.';
 if(status===403)return 'No tienes acceso a ese negocio.';
 if(status===404)return 'No encontré esa página.';
 if(status===409)return 'Esa cuenta o solicitud ya existe. Revisa tus datos.';
 if(status===413)return 'El archivo o mensaje es demasiado grande.';
 if(status===415)return 'Ese formato de audio no es compatible.';
 if(status===422)return 'No pude entender o validar ese audio. Inténtalo con una nota más clara.';
 if(status===429)return 'Llegaste al límite de mensajes por ahora. Intenta más tarde.';
 if(error?.name==='TimeoutError'||error?.name==='AbortError')return 'La conexión tardó demasiado. Reintenta con el mismo mensaje.';
 if(status>=500)return 'El servicio está ocupado. Reintenta con el mismo mensaje; no se duplicará.';
 return 'No pude completar la solicitud. Revisa los datos e intenta de nuevo.';
}
export function createHandler({store,interpreter=interpret,transcriber=transcribeAudio,demoUser=null,env=process.env,fetcher=fetch}={}) {
 return async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  let path='unknown',actor=null,business=null;
  try {
   if(env.VERCEL && (demoUser || env.APP_MODE==='demo')) throw new Error('Demo mode forbidden on Vercel');
   path=new URL(req.url,'http://local').pathname;
   if(path==='/api/health') return reply(res,200,{ok:true,mode:demoUser?'demo':'live'});
   if(path==='/api/plan'&&req.method==='GET') {
    const plan=commercialConfig(env);
    const requestedBusiness=new URL(req.url,'http://local').searchParams.get('businessId');
    return reply(res,200,{plan:plan.plan,price_cents:plan.priceCents,currency:plan.currency,period:plan.period,trial_days:plan.trialDays,
     checkout_available:!!(requestedBusiness&&requestedBusiness===env.MP_TEST_ALLOWED_BUSINESS_ID&&testBuyerId(env)&&/^(?:TEST-|APP_USR-)/.test(env.MP_TEST_ACCESS_TOKEN||'')&&env.MP_WEBHOOK_SECRET&&/^https:\/\//.test(env.VENDIXA_PUBLIC_URL||''))});
   }
   if(!store) store=new SupabaseStore(env,fetcher);
   if(path==='/api/whatsapp') {
    if(env.WHATSAPP_ENABLED!=='true') return reply(res,503,{error:'WhatsApp no habilitado.'});
    if(!env.WHATSAPP_APP_SECRET||!env.WHATSAPP_VERIFY_TOKEN||!env.WHATSAPP_ACCESS_TOKEN||!/^v\d+\.\d+$/.test(env.WHATSAPP_GRAPH_VERSION||'')) throw new Error('WhatsApp configuration incomplete');
    if(req.method==='GET') {
     const q=new URL(req.url,'http://local').searchParams;
     if(q.get('hub.mode')!=='subscribe'||q.get('hub.verify_token')!==env.WHATSAPP_VERIFY_TOKEN) return reply(res,403,{error:'Verificación inválida.'});
     res.statusCode=200;res.setHeader('Content-Type','text/plain');return res.end(q.get('hub.challenge') || '');
    }
    if(req.method!=='POST') return reply(res,405,{error:'Método no permitido.'});
    const raw=await readBody(req);
    if(!validSignature(raw,req.headers['x-hub-signature-256'],env.WHATSAPP_APP_SECRET)) return reply(res,401,{error:'Firma inválida.'});
    await receiveWhatsApp(JSON.parse(raw.toString()),{store,interpreter,env,fetcher});
    return reply(res,200,{received:true});
   }
   if(path==='/api/mercado-pago/webhook'&&req.method==='POST') {
    const body=JSON.parse((await readBody(req,16384)).toString());
    const result=await handleMpWebhook({store,query:new URL(req.url,'http://local').searchParams,headers:req.headers,body,env,fetcher});
    return reply(res,200,{received:true,...result});
   }
   if(req.method==='POST' && req.headers.origin) {
    const origin=new URL(req.headers.origin);
    if(origin.host!==req.headers.host) return reply(res,403,{error:'Origen inválido.'});
   }
   if(path==='/api/signup' && req.method==='POST') {
    if(demoUser||(env.COMMERCIAL_SIGNUP_ENABLED??env.PILOT_SIGNUP_ENABLED)!=='true') return reply(res,404,{error:'El registro de nuevas cuentas no está disponible.'});
    const {email,password}=JSON.parse((await readBody(req,8192)).toString());
    if(typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email)||email.length>254||typeof password!=='string'||password.length<10||password.length>128) return reply(res,400,{error:'Revisa el correo y la contraseña.'});
    const data=await store.auth('signup',{body:{email:email.trim(),password}});
    if(data.access_token) res.setHeader('Set-Cookie',`cc_session=${data.access_token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.min(data.expires_in||3600,3600)}${env.VERCEL?'; Secure':''}`);
    return reply(res,200,{ok:true,checkEmail:!data.access_token});
   }
   if(path==='/api/login' && req.method==='POST') {
    if(demoUser) return reply(res,200,{ok:true});
    const {email,password}=JSON.parse((await readBody(req,8192)).toString());
    if(typeof email!=='string'||typeof password!=='string'||email.length>254||password.length>1024) return reply(res,400,{error:'Credenciales inválidas.'});
    const data=await store.auth('token?grant_type=password',{body:{email,password}});
    res.setHeader('Set-Cookie',`cc_session=${data.access_token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.min(data.expires_in || 3600,3600)}${env.VERCEL?'; Secure':''}`);
    return reply(res,200,{ok:true});
   }
   if(path==='/api/logout'&&req.method==='POST') {
    res.setHeader('Set-Cookie',`cc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${env.VERCEL?'; Secure':''}`);
    return reply(res,200,{ok:true});
   }
   const token=cookie(req,'cc_session');
   if(!demoUser&&!token) return reply(res,401,{error:'Inicia sesión para continuar.'});
   const authUser=demoUser?{id:demoUser}:await store.auth('user',{token});
   actor=authUser.id;
   if(path==='/api/session'&&req.method==='GET') {
    const list=await store.businesses(actor);
    await Promise.all(list.filter(b=>b.is_pilot).map(b=>store.presence(actor,b.id)));
    return reply(res,200,{mode:demoUser?'demo':'live',businesses:list,operator:await store.operator(actor)});
   }
   if(path==='/api/businesses'&&req.method==='POST') {
    const input=JSON.parse((await readBody(req,8192)).toString());
    const name=typeof input.name==='string'&&input.name.trim()?input.name.trim():'Mi negocio';
    if(name.length>120||typeof input.timezone!=='string'||input.timezone.length>100) return reply(res,400,{error:'Revisa el nombre y la zona horaria.'});
    const result=demoUser?await store.createPilotBusiness(actor,name,input.timezone):await store.createBusinessTrial(actor,name,input.timezone,commercialConfig(env).trialDays);
    return reply(res,200,result);
   }
   if(path==='/api/access'&&req.method==='GET') {
    business=new URL(req.url,'http://local').searchParams.get('businessId');
    if(!uuid.test(business||''))return reply(res,400,{error:'Negocio inválido.'});
    if(!await store.membership(actor,business))return reply(res,403,{error:'No tienes acceso a ese negocio.'});
    return reply(res,200,await store.access(actor,business));
   }
   if(path==='/api/admin/billing-check'&&req.method==='GET') {
    if(!await store.operator(actor))return reply(res,403,{error:'No tienes acceso al panel.'});
    return reply(res,200,{
     test_token:await verifyMpTestSeller({token:env.MP_TEST_ACCESS_TOKEN,fetcher}).catch(()=>false),
     token_present:!!env.MP_TEST_ACCESS_TOKEN,
     token_has_whitespace:typeof env.MP_TEST_ACCESS_TOKEN==='string'&&env.MP_TEST_ACCESS_TOKEN.trim()!==env.MP_TEST_ACCESS_TOKEN,
     token_has_wrapping_quotes:typeof env.MP_TEST_ACCESS_TOKEN==='string'&&/^["']|["']$/.test(env.MP_TEST_ACCESS_TOKEN),
     test_buyer:!!await resolveMpTestBuyer({userId:testBuyerId(env),token:env.MP_TEST_ACCESS_TOKEN,fetcher}).catch(()=>null),
     test_business:uuid.test(env.MP_TEST_ALLOWED_BUSINESS_ID||''),
     webhook_secret:!!env.MP_WEBHOOK_SECRET,
     public_url:/^https:\/\//.test(env.VENDIXA_PUBLIC_URL||'')
    });
   }
   if(path==='/api/checkout'&&req.method==='POST') {
    const input=JSON.parse((await readBody(req,8192)).toString());
    if(!uuid.test(input.businessId||'')||!authUser.email)return reply(res,400,{error:'Negocio inválido.'});
    business=input.businessId;
    return reply(res,200,await createCheckout({store,actor,business,email:authUser.email,env,fetcher}));
   }
   if(path==='/api/admin/subscriptions'&&req.method==='GET') {
    if(!await store.operator(actor))return reply(res,403,{error:'No tienes acceso al panel.'});
    return reply(res,200,{businesses:await store.commercialDashboard(actor)});
   }
   if(path==='/api/admin/subscription-action'&&req.method==='POST') {
    if(!await store.operator(actor))return reply(res,403,{error:'No tienes acceso al panel.'});
    const input=JSON.parse((await readBody(req,8192)).toString());
    if(!uuid.test(input.businessId||'')||!['activate','renew','suspend','cancel'].includes(input.action)||
     (input.amountCents!=null&&(!Number.isSafeInteger(input.amountCents)||input.amountCents<0))||
     (input.note!=null&&(typeof input.note!=='string'||input.note.length>500)))return reply(res,400,{error:'Revisa los datos de la activación.'});
    return reply(res,200,await store.operatorSubscriptionAction(actor,input));
   }
   if(path==='/api/admin/pilots'&&req.method==='GET') {
    if(!await store.operator(actor)) return reply(res,403,{error:'No tienes acceso al panel.'});
    return reply(res,200,{pilots:await store.dashboard(actor)});
   }
   if(path==='/api/admin/deactivate'&&req.method==='POST') {
    if(!await store.operator(actor)) return reply(res,403,{error:'No tienes acceso al panel.'});
    const input=JSON.parse((await readBody(req,8192)).toString());
    if(!uuid.test(input.businessId||'')||typeof input.name!=='string'||input.phrase!=='DESACTIVAR NEGOCIO')return reply(res,400,{error:'La confirmación no coincide.'});
    return reply(res,200,await store.deactivatePilot(actor,input.businessId,input.name,'DESACTIVAR PILOTO'));
   }
   if(path==='/api/messages'&&req.method==='POST') {
    const {businessId,id,text}=JSON.parse((await readBody(req,16384)).toString());
    if(!uuid.test(businessId||'')) return reply(res,400,{error:'Negocio inválido.'});
    business=businessId;
    const result=await handleMessage({store,interpreter,business:businessId,actor,channel:'web',externalId:id,text,limits:{perMinute:limit(env.PILOT_MESSAGES_PER_MINUTE,30,1000),perDay:limit(env.PILOT_MESSAGES_PER_DAY,250,10000)}});
    await touch(store,actor,businessId);
    return reply(res,200,result);
   }
   if(path==='/api/audio'&&req.method==='POST') {
    const businessId=req.headers['x-cc-business-id'],id=req.headers['x-cc-message-id'];
    if(!uuid.test(businessId||'')||!uuid.test(id||'')) return reply(res,400,{error:'Negocio o mensaje inválido.'});
    business=businessId;
    if(Number(req.headers['content-length'])>MAX_AUDIO_BYTES) return reply(res,413,{error:'El audio supera 3 MB.'});
    const bytes=await readBody(req,MAX_AUDIO_BYTES);
    const details=await validateAudio(bytes,req.headers['content-type']);
    if(!await store.membership(actor,businessId)) return reply(res,403,{error:'No autorizado.'});
    const receipt=await store.receipt(businessId,'web',id);
    const media={type:'audio',origin:'web',...details};
    if(receipt) {
      if(receipt.actor_id!==actor||receipt.fingerprint!==messageFingerprint('',media)) return reply(res,409,{error:'Ese identificador ya se utilizó con otro mensaje.'});
      const transcript=receipt.media?.transcript||receipt.media?.transcribed_text||'';
      const result=await handleMessage({store,interpreter,business:businessId,actor,channel:'web',externalId:id,text:transcript||'[Audio sin voz inteligible]',media:{...media,...receipt.media}});
      await touch(store,actor,businessId);
      return reply(res,200,{...result,transcript});
    }
    if(!await store.quota(actor,businessId,{perMinute:limit(env.PILOT_MESSAGES_PER_MINUTE,30,1000),perDay:limit(env.PILOT_MESSAGES_PER_DAY,250,10000)})) return reply(res,429,{error:'Llegaste al límite de mensajes por ahora. Intenta más tarde.'});
    const transcription=await transcriber(bytes,{mime:details.mime,key:env.GEMINI_API_KEY,model:env.GEMINI_TRANSCRIBE_MODEL||env.GEMINI_MODEL||'gemini-3.5-flash-lite',fetcher});
    const transcript=typeof transcription?.text==='string'?transcription.text.trim():'';
    if(transcript.length>4000) return reply(res,422,{error:'La transcripción es demasiado larga.'});
    const fullMedia={...media,transcribed:true,transcript,transcription_provider:transcription.provider||'gemini',transcription_model:transcription.model||null,ambiguous:!transcript};
    const result=await handleMessage({store,interpreter,business:businessId,actor,channel:'web',externalId:id,text:transcript||'[Audio sin voz inteligible]',media:fullMedia,quotaConsumed:true});
    await touch(store,actor,businessId);
    return reply(res,200,{...result,transcript});
   }
   return reply(res,404,{error:'Ruta no encontrada.'});
  } catch(error) {
   // No message bodies, tokens, passwords or model output in logs.
   const status=error instanceof SyntaxError?400:error.status||503;
   const code=error?.name==='TimeoutError'?'timeout':status===503?'provider_or_database':`http_${status}`;
   console.error(JSON.stringify({event:'request_failed',endpoint:path,status,code,at:new Date().toISOString(),actor:actor||undefined,business:business||undefined}));
   if(actor&&business&&uuid.test(business)) {
    try {if(await store.membership(actor,business)) await store.event(actor,business,'error_returned',code);} catch {}
   }
   reply(res,status,{error:friendlyError(error,status)});
  }
 };
}
export default createHandler();
