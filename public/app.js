import {wavPreview} from './audio-preview.js';
const $=id=>document.getElementById(id);
let businesses=[],pending=null,busy=false,commercialPlan=null;
async function api(path,body) {
 const res=await fetch(`/api/${path}`,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const data=await res.json();if(!res.ok) throw Object.assign(new Error(data.error||'Error de conexión'),{status:res.status});return data;
}
function bubble(text,type='assistant') {const el=document.createElement('div');el.className=`bubble ${type}`;el.textContent=text;$('messages').append(el);$('messages').scrollTop=$('messages').scrollHeight;}
function timezone() {$('timezone').textContent=businesses.find(x=>x.id===$('business').value)?.timezone || '';accessBanner();}
function accessBanner(){
 const access=businesses.find(x=>x.id===$('business').value)?.access;
 $('access-banner').hidden=!access;
 if(!access)return;
 const end=access.current_period_end?new Date(access.current_period_end).toLocaleDateString('es-MX'):'—';
 $('access-text').textContent=access.status==='trialing'?`Tu prueba gratuita termina el ${end}.`:
  access.can_write?`Vendixa está activo hasta el ${end}.`:'Tu periodo terminó. Tus datos siguen disponibles. Activa Vendixa para continuar.';
 const online=!!commercialPlan?.checkout_available;
 $('checkout').hidden=!online||access.status==='active'&&access.can_write;
 $('plan-price').textContent=online&&!(access.status==='active'&&access.can_write)?
  `Plan mensual: ${(commercialPlan.price_cents/100).toLocaleString('es-MX',{style:'currency',currency:'MXN'})} MXN.`:
  !access.can_write?'La activación en línea estará disponible próximamente.':'';
}
function account(mode='login',message='Entra a tu cuenta para continuar.') {
 $('landing').hidden=true;$('workspace').hidden=true;$('account').hidden=false;$('onboarding').hidden=true;
 $('login').hidden=mode!=='login';$('signup').hidden=mode!=='signup';$('notice').textContent=message;
 window.scrollTo({top:0,behavior:'auto'});
}
function home(){if(!$('workspace').hidden)return;$('landing').hidden=false;$('account').hidden=true;window.scrollTo({top:0,behavior:'auto'});}
function closeMobileMenu(){const menu=$('mobile-menu'),button=$('mobile-menu-toggle');menu.hidden=true;button.setAttribute('aria-expanded','false');button.setAttribute('aria-label','Abrir menú');}
$('mobile-menu-toggle').addEventListener('click',()=>{const menu=$('mobile-menu'),button=$('mobile-menu-toggle');menu.hidden=!menu.hidden;button.setAttribute('aria-expanded',String(!menu.hidden));button.setAttribute('aria-label',menu.hidden?'Abrir menú':'Cerrar menú');});
document.addEventListener('click',event=>{if(!$('mobile-menu').hidden&&!$('mobile-menu').contains(event.target)&&!$('mobile-menu-toggle').contains(event.target))closeMobileMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMobileMenu();});
document.querySelectorAll('[data-auth]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();account(link.dataset.auth,link.dataset.auth==='signup'?'Crea tu cuenta y empieza gratis.':'Entra a tu cuenta para continuar.');}));
$('back-home').addEventListener('click',home);
async function session() {
 try {
  commercialPlan=await api('plan');
  const data=await api('session');businesses=data.businesses;$('business').replaceChildren();
  businesses.forEach(b=>{const o=document.createElement('option');o.value=b.id;o.textContent=b.name;$('business').append(o);});if(pending&&businesses.some(b=>b.id===pending.businessId))$('business').value=pending.businessId;timezone();
  $('landing').hidden=true;$('login').hidden=true;$('signup').hidden=true;$('account').hidden=!!businesses.length;$('onboarding').hidden=!!businesses.length;$('workspace').hidden=!businesses.length;$('admin-link').hidden=!data.operator;$('mobile-admin-link').hidden=!data.operator;closeMobileMenu();
  $('notice').textContent=!businesses.length?'Agrega tu negocio para empezar.':'';window.scrollTo({top:0,behavior:'auto'});
  $('connection').textContent='Aquí puedes contarme lo que pasó en tu negocio';
 } catch(e){$('workspace').hidden=true;$('onboarding').hidden=true;$('account').hidden=true;$('landing').hidden=false;if(e.status!==401)account('login',e.message);}
}
$('login').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('login',Object.fromEntries(new FormData(e.currentTarget)));$('login').reset();await session();}catch(e){$('notice').textContent=e.message;}finally{button.disabled=false;}});
$('show-signup').addEventListener('click',()=>account('signup','Crea tu cuenta y empieza gratis.'));
$('show-login').addEventListener('click',()=>account('login','Entra a tu cuenta.'));
$('signup').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{const result=await api('signup',Object.fromEntries(new FormData(e.currentTarget)));$('signup').reset();if(result.checkEmail){$('signup').hidden=true;$('login').hidden=false;$('notice').textContent='Revisa tu correo para confirmar la cuenta y luego inicia sesión.';}else await session();}catch(error){$('notice').textContent=error.message;}finally{button.disabled=false;}});
$('create-business').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('businesses',Object.fromEntries(new FormData(e.currentTarget)));await session();bubble('Listo. Puedes registrar tu primera venta, gasto o cuenta por cobrar; también puedes grabar una nota de voz.');}catch(error){$('notice').textContent=error.message;}finally{button.disabled=false;}});
async function send() {
 if(!pending||busy)return;const wasAudio=!!pending.audio;busy=true;$('send').disabled=true;$('business').disabled=true;$('text').disabled=true;$('retry').hidden=true;
 try {let r;if(pending.audio){const res=await fetch('/api/audio',{method:'POST',headers:{'Content-Type':pending.audio.type,'X-CC-Business-Id':pending.businessId,'X-CC-Message-Id':pending.id},body:pending.audio});r=await res.json();if(!res.ok)throw Object.assign(new Error(r.error||'Error de conexión'),{status:res.status});}else r=await api('messages',pending);bubble(r.text);pending=null;clearAudio();}
 catch(e){bubble(e.message,'error');if(e.status===400||e.status===402||e.status===403||e.status===409)pending=null;else $('retry').hidden=false;if(e.status===402)await session();if(e.status===401)account('login','Tu sesión caducó. Entra de nuevo; conservaré el mensaje para que puedas reintentarlo.');}
 finally{busy=false;$('send').disabled=!!pending;$('business').disabled=!!pending;$('text').disabled=!!pending;if(!pending&&!wasAudio)$('text').focus();}
}
$('compose').addEventListener('submit',async e=>{e.preventDefault();if(pending||busy)return;const text=$('text').value.trim();if(!text)return;pending={id:crypto.randomUUID(),businessId:$('business').value,text};bubble(text,'user');$('text').value='';await send();});
$('retry').addEventListener('click',send);
$('text').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('compose').requestSubmit();}});
document.querySelectorAll('[data-example]').forEach(b=>b.addEventListener('click',()=>{if(!pending&&!busy){$('text').value=b.dataset.example;$('text').focus();}}));
$('business').addEventListener('change',()=>{$('messages').replaceChildren();bubble('Cambiaste de negocio. Los siguientes mensajes se guardarán aquí.');timezone();clearAudio();closeMobileMenu();});
$('checkout').addEventListener('click',async()=>{const button=$('checkout');button.disabled=true;try{const result=await api('checkout',{businessId:$('business').value});window.location.assign(result.url);}catch(error){bubble(error.message,'error');button.disabled=false;}});
async function logout(){closeMobileMenu();await api('logout',{});pending=null;location.reload();}
$('logout').addEventListener('click',logout);
$('mobile-logout').addEventListener('click',logout);
$('logout-onboarding').addEventListener('click',async()=>{await api('logout',{});location.reload();});
await session();

let recorder=null,stream=null,chunks=[],audioBlob=null,audioURL=null,stopTimer=null;
let audioContext=null,audioSource=null,audioProcessor=null,audioMute=null,pcmChunks=[],pcmRate=48000;
const voiceStatus=message=>{$('voice-status').textContent=message;};
function clearAudio(){
 if(audioURL)URL.revokeObjectURL(audioURL);
 audioURL=null;audioBlob=null;const player=$('audio-preview');player.pause();player.removeAttribute('src');player.load();
 $('voice-preview').hidden=true;$('audio-file').value='';voiceStatus('Puedes contar varias operaciones · máximo 60 segundos y 3 MB.');
}
function previewAudio(blob,playback=blob){
 if(blob.size>3_000_000){voiceStatus('El audio supera 3 MB. Graba uno más corto.');return;}
 clearAudio();audioBlob=blob;audioURL=URL.createObjectURL(playback);
 const player=$('audio-preview');player.src=audioURL;player.load();$('voice-preview').hidden=false;
 voiceStatus('Pulsa ▶ Escuchar para revisar la nota antes de enviarla.');
}
function releaseMic(){
 if(stopTimer)clearTimeout(stopTimer);stopTimer=null;audioProcessor?.disconnect();audioSource?.disconnect();audioMute?.disconnect();
 audioProcessor=null;audioSource=null;audioMute=null;audioContext?.close().catch(()=>{});audioContext=null;
 stream?.getTracks().forEach(track=>track.stop());stream=null;$('record').hidden=false;$('stop-record').hidden=true;
}
$('record').addEventListener('click',async()=>{
 if(busy||pending)return;
 if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){voiceStatus('Este navegador no permite grabar. Puedes subir un archivo de audio.');return;}
 try{
  const Context=window.AudioContext||window.webkitAudioContext;
  if(Context){try{audioContext=new Context();audioContext.resume().catch(()=>{});}catch{audioContext=null;}}
  stream=await navigator.mediaDevices.getUserMedia({audio:true});
  const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
  recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);chunks=[];pcmChunks=[];
  if(audioContext){try{pcmRate=audioContext.sampleRate;
   audioSource=audioContext.createMediaStreamSource(stream);audioProcessor=audioContext.createScriptProcessor(4096,1,1);
   audioMute=audioContext.createGain();audioMute.gain.value=0;
   audioProcessor.onaudioprocess=event=>pcmChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
   audioSource.connect(audioProcessor);audioProcessor.connect(audioMute);audioMute.connect(audioContext.destination);
  }catch{audioProcessor?.disconnect();audioSource?.disconnect();audioMute?.disconnect();audioContext?.close().catch(()=>{});audioContext=null;pcmChunks=[];}}
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  recorder.onstop=()=>{const blob=new Blob(chunks,{type:recorder.mimeType||chunks[0]?.type||''});const playback=pcmChunks.length?wavPreview(pcmChunks,pcmRate):blob;chunks=[];pcmChunks=[];releaseMic();previewAudio(blob,playback);};
  recorder.start();$('record').hidden=true;$('stop-record').hidden=false;
  voiceStatus('Grabando… pulsa Detener al terminar.');stopTimer=setTimeout(()=>recorder?.state==='recording'&&recorder.stop(),59_000);
 }catch{releaseMic();voiceStatus('No pude acceder al micrófono. Revisa el permiso o sube un archivo.');}
});
$('stop-record').addEventListener('click',()=>{if(recorder?.state==='recording')recorder.stop();});
$('audio-file').addEventListener('change',e=>{if(e.target.files?.[0])previewAudio(e.target.files[0]);});
$('play-audio').addEventListener('click',async()=>{if(!audioBlob)return;const player=$('audio-preview');try{if(player.readyState===0)player.load();if(player.seekable.length)player.currentTime=0;await player.play();voiceStatus('Reproduciendo tu nota de voz.');}catch{voiceStatus('No pude reproducir este formato aquí. Puedes cancelar y grabar otra nota.');}});
$('cancel-audio').addEventListener('click',clearAudio);
$('send-audio').addEventListener('click',async()=>{if(!audioBlob||busy||pending)return;pending={id:crypto.randomUUID(),businessId:$('business').value,audio:audioBlob};bubble('🎙 Nota de voz','user');await send();});
