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
  $('login').hidden=true;$('workspace').hidden=!businesses.length;
  $('notice').textContent=!businesses.length?'Tu cuenta aún no tiene un negocio asignado. Pide al responsable del piloto que complete el alta.':data.mode==='demo'?'DEMO LOCAL · Los registros se guardan en este equipo. El intérprete de prueba reconoce los ejemplos de esta página; Supabase, Gemini y WhatsApp aún no están conectados.':'PILOTO · Registros guardados en Supabase. Este chat prueba el mismo flujo que usará WhatsApp.';
  $('connection').textContent=data.mode==='demo'?'Prueba local · Texto':'Conectado · Texto';
 } catch(e){$('workspace').hidden=true;$('login').hidden=false;$('notice').textContent=e.message;}
}
$('login').addEventListener('submit',async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button');button.disabled=true;try{await api('login',Object.fromEntries(new FormData(e.currentTarget)));$('login').reset();await session();}catch(e){$('notice').textContent=e.message;}finally{button.disabled=false;}});
async function send() {
 if(!pending||busy)return;busy=true;$('send').disabled=true;$('business').disabled=true;$('text').disabled=true;$('retry').hidden=true;
 try {const r=await api('messages',pending);bubble(r.text);pending=null;}
 catch(e){bubble(e.message,'error');if(e.status===400||e.status===403||e.status===409)pending=null;else $('retry').hidden=false;if(e.status===401){$('login').hidden=false;$('notice').textContent='Tu sesión caducó. Entra de nuevo y pulsa Reintentar; conservaré el identificador del mensaje.';}}
 finally{busy=false;$('send').disabled=!!pending;$('business').disabled=!!pending;$('text').disabled=!!pending;if(!pending)$('text').focus();}
}
$('compose').addEventListener('submit',async e=>{e.preventDefault();if(pending||busy)return;const text=$('text').value.trim();if(!text)return;pending={id:crypto.randomUUID(),businessId:$('business').value,text};bubble(text,'user');$('text').value='';await send();});
$('retry').addEventListener('click',send);
$('text').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('compose').requestSubmit();}});
document.querySelectorAll('[data-example]').forEach(b=>b.addEventListener('click',()=>{if(!pending&&!busy){$('text').value=b.dataset.example;$('text').focus();}}));
$('business').addEventListener('change',()=>{$('messages').replaceChildren();bubble('Cambiaste de negocio. Los siguientes mensajes se guardarán aquí.');timezone();});
$('logout').addEventListener('click',async()=>{await api('logout',{});pending=null;location.reload();});
await session();
