import {createHash} from 'node:crypto';
import {control,normalizeInput,queryIntents,render} from './domain.js';
export function messageFingerprint(text,media=null) {
  // Audio retries are identified by the original bytes, even if a second transcription differs.
  return createHash('sha256').update(media?.type==='audio'&&media.sha256 ? `audio:${media.sha256}` : JSON.stringify({text,media})).digest('hex');
}
function withTranscript(result,media) {
  result={...result};
  for(const key of ['sales_cents','expenses_cents','payments_cents','previous_sales_cents','balance_cents']) {
    if(typeof result[key]==='string'&&/^\d+$/.test(result[key])&&BigInt(result[key])<=BigInt(Number.MAX_SAFE_INTEGER)) result[key]=Number(result[key]);
  }
  return {...result,text:media?.type==='audio'&&media.transcript ? `Escuché: ${media.transcript}\n${render(result)}` : render(result)};
}
export async function handleMessage({store,interpreter,business,actor,channel,externalId,text,media=null,quotaConsumed=false}) {
  if(typeof text!=='string'||!text.trim()||text.length>4000||typeof externalId!=='string'||!externalId||externalId.length>200||!['web','whatsapp'].includes(channel)) {
    throw Object.assign(new Error('Mensaje inválido.'),{status:400});
  }
  if(!await store.membership(actor,business)) throw Object.assign(new Error('No autorizado.'),{status:403});
  const fingerprint=messageFingerprint(text,media);
  const receipt=await store.receipt(business,channel,externalId);
  if(receipt) {
    if(receipt.actor_id!==actor||receipt.fingerprint!==fingerprint) throw Object.assign(new Error('Ese identificador ya se utilizó con otro mensaje.'),{status:409});
    return {...withTranscript(receipt.response,receipt.media||media),duplicate:true};
  }
  if(!quotaConsumed&&!await store.quota(actor)) throw Object.assign(new Error('Demasiados mensajes. Intenta de nuevo en un minuto.'),{status:429});
  const command=media?.type==='audio'&&(!media.transcribed||media.ambiguous) ? {intent:'clarify'} : control(text)||normalizeInput(await interpreter(text));
  const envelope={p_business:business,p_actor:actor,p_channel:channel,p_external_id:externalId,p_fingerprint:fingerprint,p_content:text,p_media:media};
  const result=command.intent==='batch' ? await store.batch({...envelope,p_commands:command.operations}) : queryIntents.has(command.intent) ? await store.query({...envelope,p_command:command}) : await store.process({...envelope,p_command:command});
  return withTranscript(result,media);
}
