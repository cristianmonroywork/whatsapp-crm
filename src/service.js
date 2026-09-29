import {createHash} from 'node:crypto';
import {control,normalize,render} from './domain.js';
export function messageFingerprint(text,media=null) {
  // Audio retries are identified by the original bytes, even if a second transcription differs.
  return createHash('sha256').update(media?.type==='audio'&&media.sha256 ? `audio:${media.sha256}` : JSON.stringify({text,media})).digest('hex');
}
function withTranscript(result,media) {
  const answer=media?.multiple_operations&&result.status==='clarify' ? 'Escuché varias operaciones. Envíalas por separado, una por nota de voz. No registré cambios.' : render(result);
  return {...result,text:media?.type==='audio'&&media.transcript ? `Escuché: ${media.transcript}\n${answer}` : answer};
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
  // Future voice adapter supplies a transcript plus media provenance through this exact boundary.
  // Unsupported media is logged and acknowledged, but never generates financial data.
  const command=media?.type==='audio'&&(!media.transcribed||media.ambiguous) ? {intent:'clarify'} : control(text)||normalize(await interpreter(text));
  const result=await store.process({p_business:business,p_actor:actor,p_channel:channel,p_external_id:externalId,p_fingerprint:fingerprint,p_content:text,p_command:command,p_media:media});
  return withTranscript(result,media);
}
