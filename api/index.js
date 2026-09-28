import {SupabaseStore} from '../src/store.js';
import {interpret} from '../src/interpret.js';
import {handleMessage} from '../src/service.js';
import {validSignature,receiveWhatsApp} from '../src/whatsapp.js';

export async function readBody(req,limit=65536) {
  let length=0;const chunks=[];
  for await(const chunk of req) {length+=Buffer.byteLength(chunk);if(length>limit) throw Object.assign(new Error('Mensaje demasiado grande.'),{status:413});chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks);
}
function reply(res,status,body) {res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(body));}
function cookie(req,name) {return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${name}=`))?.slice(name.length+1);}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createHandler({store,interpreter=interpret,demoUser=null,env=process.env,fetcher=fetch}={}) {
 return async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try {
   if(env.VERCEL && (demoUser || env.APP_MODE==='demo')) throw new Error('Demo mode forbidden on Vercel');
   const path=new URL(req.url,'http://local').pathname;
   if(path==='/api/health') return reply(res,200,{ok:true,mode:demoUser?'demo':'live'});
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
   if(req.method==='POST' && req.headers.origin) {
    const origin=new URL(req.headers.origin);
    if(origin.host!==req.headers.host) return reply(res,403,{error:'Origen inválido.'});
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
   const actor=demoUser || (await store.auth('user',{token})).id;
   if(path==='/api/session'&&req.method==='GET') return reply(res,200,{mode:demoUser?'demo':'live',businesses:await store.businesses(actor)});
   if(path==='/api/messages'&&req.method==='POST') {
    const {businessId,id,text}=JSON.parse((await readBody(req,16384)).toString());
    if(!uuid.test(businessId||'')) return reply(res,400,{error:'Negocio inválido.'});
    const result=await handleMessage({store,interpreter,business:businessId,actor,channel:'web',externalId:id,text});
    return reply(res,200,result);
   }
   return reply(res,404,{error:'Ruta no encontrada.'});
  } catch(error) {
   // No message bodies, tokens, passwords or model output in logs.
   const status=error instanceof SyntaxError?400:error.status||503;
   console.error(JSON.stringify({event:'request_failed',status}));
   reply(res,status,{error:status===503?'No pude completar la solicitud. Reintenta con el mismo mensaje; no se duplicará.':status===400?'Solicitud inválida.':error.message});
  }
 };
}
export default createHandler();
