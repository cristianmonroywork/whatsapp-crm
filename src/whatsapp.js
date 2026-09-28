import {createHmac,timingSafeEqual} from 'node:crypto';
import {handleMessage} from './service.js';
export function validSignature(raw,signature,secret) {
  if(!secret || typeof signature!=='string'||!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected=createHmac('sha256',secret).update(raw).digest();
  return timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'));
}
export async function sendDelivery(store,id,env=process.env,fetcher=fetch) {
  if((await store.delivery(id))?.status==='sent') return;
  const [item]=await store.claim(id);
  if(!item) throw new Error('Delivery is leased; retry later');
  try {
    const response=await fetcher(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(item.phone_number_id)}/messages`,{
      method:'POST',headers:{Authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(12000),
      body:JSON.stringify({messaging_product:'whatsapp',to:item.recipient,type:'text',text:{body:item.body}})
    });
    if(!response.ok) throw new Error('Meta delivery failed');
    const data=await response.json();
    if(!data.messages?.[0]?.id) throw new Error('Missing delivery receipt');
    await store.markDelivery(id,{status:'sent',sent_at:new Date().toISOString(),provider_id:data.messages[0].id,lease_until:null});
  } catch(error) {
    await store.markDelivery(id,{status:'pending',lease_until:null});
    throw error;
  }
}
export async function receiveWhatsApp(payload,{store,interpreter,env=process.env,fetcher=fetch}) {
  if(payload.object!=='whatsapp_business_account') throw Object.assign(new Error('Invalid webhook'),{status:400});
  for(const entry of payload.entry || []) for(const change of entry.changes || []) {
    const value=change.value;
    if(!value?.messages) continue; // Delivery statuses do not create financial entries.
    for(const message of value.messages) {
      const phone=value.metadata?.phone_number_id;
      if(!phone||!message.from||!message.id) continue;
      const binding=await store.binding(phone,message.from);
      if(!binding) continue; // No automatic trust/enrolment of senders.
      const isText=message.type==='text';
      const media=isText?null:{type:message.type,id:message.audio?.id || null,transcribed:false};
      const result=await handleMessage({store,interpreter,business:binding.business_id,actor:binding.user_id,channel:'whatsapp',externalId:message.id,text:isText?message.text?.body:`[${message.type} recibido; envía texto por ahora]`,media});
      await store.enqueue(result.message_id,{...binding,sender:message.from,phone},result.text);
      await sendDelivery(store,result.message_id,env,fetcher);
    }
  }
}
