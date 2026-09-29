const $=id=>document.getElementById(id);
let businesses=[],pending=null,busy=false;
async function api(path,body) {
 const res=await fetch(`/api/${path}`,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 const data=await res.json();if(!res.ok) throw Object.assign(new Error(data.error||'Error de conexión'),{status:res.status});return data;
}
function bubble(text,type='assistant') {const el=document.createElement('div');el.className=`bubble ${type}`;el.textContent=text;$('messages').append(el);$('messages').scrollTop=$('messages').scrollHeight;}
function timezone() {$('timezone').textContent=businesses.find(x=>x.id===$('business').value)?.timezone || '';}
async function session() {
 try {
  const data=await api('session');businesses=data.businesses;$('business').replaceChildren();
  businesses.forEach(b=>{const o=document.createElement('option');o.value=b.id;o.textContent=b.name;$('business').append(o);});if(pending&&businesses.some(b=>b.id===pending.businessId))$('business').value=pending.businessId;timezone();
  $('login').hidden=true;$('signup').hidden=true;$('onboarding').hidden=!!businesses.length;$('workspace').hidden=!businesses.length;$('admin-link').hidden=!data.operator;
  $('notice').textContent=!businesses.length?'Un paso más: crea tu negocio piloto.':data.mode==='demo'?'DEMO LOCAL · Los registros se guardan en este equipo. El intérprete de texto sólo reconoce los ejemplos. La voz necesita una clave de Gemini en el archivo de entorno local; Supabase y WhatsApp no están conectados.':'PILOTO · Registros guardados en Supabase. Puedes escribir o enviar una nota de voz.';
  $('connection').textContent=data.mode==='demo'?'Prueba local · Texto y voz':'Conectado · Texto y voz';
 } catch(e){$('workspace').hidden=true;$('onboarding').hidden=true;$('signup').hidden=true;$('login').hidden=false;$('notice').textContent=e.status===401?'Entra o crea tu cuenta para continuar.':e.message;}
}
$('login').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('login',Object.fromEntries(new FormData(e.currentTarget)));$('login').reset();await session();}catch(e){$('notice').textContent=e.message;}finally{button.disabled=false;}});
$('show-signup').addEventListener('click',()=>{$('login').hidden=true;$('signup').hidden=false;$('notice').textContent='Crea tu cuenta con el código que te dio el operador del piloto.';});
$('show-login').addEventListener('click',()=>{$('signup').hidden=true;$('login').hidden=false;$('notice').textContent='Entra a tu negocio.';});
$('signup').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{const result=await api('signup',Object.fromEntries(new FormData(e.currentTarget)));$('signup').reset();if(result.checkEmail){$('signup').hidden=true;$('login').hidden=false;$('notice').textContent='Revisa tu correo para confirmar la cuenta y luego inicia sesión.';}else await session();}catch(error){$('notice').textContent=error.message;}finally{button.disabled=false;}});
$('create-business').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('businesses',Object.fromEntries(new FormData(e.currentTarget)));await session();bubble('Listo. Puedes registrar tu primera venta, gasto o cuenta por cobrar; también puedes grabar una nota de voz.');}catch(error){$('notice').textContent=error.message;}finally{button.disabled=false;}});
async function send() {
 if(!pending||busy)return;busy=true;$('send').disabled=true;$('business').disabled=true;$('text').disabled=true;$('retry').hidden=true;
 try {let r;if(pending.audio){const res=await fetch('/api/audio',{method:'POST',headers:{'Content-Type':pending.audio.type,'X-CC-Business-Id':pending.businessId,'X-CC-Message-Id':pending.id},body:pending.audio});r=await res.json();if(!res.ok)throw Object.assign(new Error(r.error||'Error de conexión'),{status:res.status});}else r=await api('messages',pending);bubble(r.text);pending=null;clearAudio();}
 catch(e){bubble(e.message,'error');if(e.status===400||e.status===403||e.status===409)pending=null;else $('retry').hidden=false;if(e.status===401){$('login').hidden=false;$('notice').textContent='Tu sesión caducó. Entra de nuevo y pulsa Reintentar; conservaré el identificador del mensaje.';}}
 finally{busy=false;$('send').disabled=!!pending;$('business').disabled=!!pending;$('text').disabled=!!pending;if(!pending)$('text').focus();}
}
$('compose').addEventListener('submit',async e=>{e.preventDefault();if(pending||busy)return;const text=$('text').value.trim();if(!text)return;pending={id:crypto.randomUUID(),businessId:$('business').value,text};bubble(text,'user');$('text').value='';await send();});
$('retry').addEventListener('click',send);
$('text').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('compose').requestSubmit();}});
document.querySelectorAll('[data-example]').forEach(b=>b.addEventListener('click',()=>{if(!pending&&!busy){$('text').value=b.dataset.example;$('text').focus();}}));
$('business').addEventListener('change',()=>{$('messages').replaceChildren();bubble('Cambiaste de negocio. Los siguientes mensajes se guardarán aquí.');timezone();clearAudio();});
$('logout').addEventListener('click',async()=>{await api('logout',{});pending=null;location.reload();});
$('logout-onboarding').addEventListener('click',async()=>{await api('logout',{});location.reload();});
await session();

let recorder=null,stream=null,chunks=[],audioBlob=null,audioURL=null,stopTimer=null;
const voiceStatus=message=>{$('voice-status').textContent=message;};
function clearAudio(){if(audioURL)URL.revokeObjectURL(audioURL);audioURL=null;audioBlob=null;$('audio-preview').removeAttribute('src');$('voice-preview').hidden=true;$('audio-file').value='';voiceStatus('Puedes contar varias operaciones · máximo 60 segundos y 3 MB.');}
function previewAudio(blob){if(blob.size>3_000_000){voiceStatus('El audio supera 3 MB. Graba uno más corto.');return;}clearAudio();audioBlob=blob;audioURL=URL.createObjectURL(blob);const player=$('audio-preview');player.src=audioURL;player.load();$('voice-preview').hidden=false;voiceStatus('Pulsa ▶ Escuchar para revisar la nota antes de enviarla.');}
function releaseMic(){if(stopTimer)clearTimeout(stopTimer);stopTimer=null;stream?.getTracks().forEach(track=>track.stop());stream=null;$('record').hidden=false;$('stop-record').hidden=true;}
$('record').addEventListener('click',async()=>{if(busy||pending)return;if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){voiceStatus('Este navegador no permite grabar. Puedes subir un archivo de audio.');return;}try{stream=await navigator.mediaDevices.getUserMedia({audio:true});const mime=['audio/mp4','audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);chunks=[];recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onstop=()=>{const blob=new Blob(chunks,{type:recorder.mimeType||chunks[0]?.type||''});chunks=[];releaseMic();previewAudio(blob);};recorder.start();$('record').hidden=true;$('stop-record').hidden=false;voiceStatus('Grabando… pulsa Detener al terminar.');stopTimer=setTimeout(()=>recorder?.state==='recording'&&recorder.stop(),59_000);}catch{releaseMic();voiceStatus('No pude acceder al micrófono. Revisa el permiso o sube un archivo.');}});
$('stop-record').addEventListener('click',()=>{if(recorder?.state==='recording')recorder.stop();});
$('audio-file').addEventListener('change',e=>{if(e.target.files?.[0])previewAudio(e.target.files[0]);});
$('play-audio').addEventListener('click',async()=>{if(!audioBlob)return;const player=$('audio-preview');try{if(player.readyState===0)player.load();if(player.seekable.length)player.currentTime=0;await player.play();voiceStatus('Reproduciendo tu nota de voz.');}catch{voiceStatus('No pude reproducir este formato aquí. Puedes cancelar y grabar otra nota.');}});
$('cancel-audio').addEventListener('click',clearAudio);
$('send-audio').addEventListener('click',async()=>{if(!audioBlob||busy||pending)return;pending={id:crypto.randomUUID(),businessId:$('business').value,audio:audioBlob};bubble('🎙 Nota de voz','user');await send();});
