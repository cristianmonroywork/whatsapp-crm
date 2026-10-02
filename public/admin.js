const status=document.getElementById('admin-status'),commercial=document.getElementById('subscriptions'),commercialBody=commercial.querySelector('tbody');
const table=document.getElementById('pilots'),body=table.querySelector('tbody'),form=document.getElementById('commercial-form');
const date=value=>value?new Date(value).toLocaleString('es-MX'):'—';
let subscriptions=[],filter='all';
const updateActionFields=()=>{form.elements.endsAt.required=form.elements.action.value==='activate';};
form.elements.action.addEventListener('change',updateActionFields);updateActionFields();
const state={trialing:'Prueba',active:'Activo',past_due:'Pago pendiente',suspended:'Suspendido',expired:'Vencido',canceled:'Cancelado'};
const source={trial:'Prueba',mercado_pago:'Mercado Pago',manual_cash:'Efectivo',manual_transfer:'Transferencia',manual_other:'Otro',promo:'Promoción',courtesy:'Cortesía'};
function renderCommercial(){
 commercialBody.replaceChildren();
 for(const b of subscriptions.filter(b=>filter==='all'||filter==='soon'&&b.days_to_expiry>=0&&b.days_to_expiry<=7||b.status===filter)){
  const row=document.createElement('tr'),expiry=b.days_to_expiry;
  const cells=[b.name,b.user_email||'—',b.plan,state[b.status]||b.status,source[b.source]||b.source,date(b.starts_at),date(b.current_period_end),b.amount_paid_cents==null?'—':`$${(Number(b.amount_paid_cents)/100).toFixed(2)} · ${date(b.last_payment_at)}`,source[b.payment_method]||b.payment_method||'—',expiry<0?'Vencido':expiry===0?'Hoy':expiry<=3?`En ${expiry} días`:expiry<=7?`En ${expiry} días`:'—'];
  for(const value of cells){const td=document.createElement('td');td.textContent=String(value??'—');row.append(td);}commercialBody.append(row);
 }
}
async function load(){
 try{
  const [access,usage,billing]=await Promise.all([fetch('/api/admin/subscriptions'),fetch('/api/admin/pilots'),fetch('/api/admin/billing-check')]);
  const billingStatus=document.getElementById('billing-status');
  if(billing.ok){const checks=await billing.json();billingStatus.textContent=`Token de prueba: ${checks.test_token?'Listo':'Pendiente'} · Valor recibido: ${checks.token_present?'Sí':'No'} · Espacios externos: ${checks.token_has_whitespace?'Sí':'No'} · Comillas externas: ${checks.token_has_wrapping_quotes?'Sí':'No'} · Comprador de prueba: ${checks.test_buyer?'Listo':'Pendiente'} · Negocio autorizado: ${checks.test_business?'Listo':'Pendiente'} · Firma del webhook: ${checks.webhook_secret?'Lista':'Pendiente'} · Dirección pública: ${checks.public_url?'Lista':'Pendiente'}.`;}
  else billingStatus.textContent='No pude comprobar la configuración de pagos.';
  const accessData=await access.json(),usageData=await usage.json();
  if(!access.ok||!usage.ok)throw Error(accessData.error||usageData.error||'No pude cargar el panel.');
  subscriptions=accessData.businesses;renderCommercial();
  const select=form.elements.businessId;select.replaceChildren();for(const b of subscriptions){const option=document.createElement('option');option.value=b.id;option.textContent=b.name;select.append(option);}
  body.replaceChildren();for(const p of usageData.pilots){const row=document.createElement('tr');const cells=[p.name,(p.users||[]).map(u=>u.name||u.email||u.id).join(', '),`${date(p.created_at)} / ${date(p.last_access)}`,p.messages,p.operations,p.queries,p.voice,p.errors,p.active_sessions,p.is_active?'Activo':'Desactivado'];for(const value of cells){const td=document.createElement('td');td.textContent=String(value??0);row.append(td);}const action=document.createElement('td');if(p.is_active){const button=document.createElement('button');button.textContent='Desactivar';button.addEventListener('click',async()=>{const name=prompt(`Escribe el nombre exacto del negocio para desactivarlo:\n${p.name}`);if(name!==p.name)return;const phrase=prompt('Escribe DESACTIVAR NEGOCIO para confirmar. Los registros quedarán conservados para auditoría.');if(phrase!=='DESACTIVAR NEGOCIO')return;button.disabled=true;try{const response=await fetch('/api/admin/deactivate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businessId:p.id,name,phrase})});const result=await response.json();if(!response.ok)throw Error(result.error||'No pude desactivar el negocio.');await load();}catch(error){status.textContent=error.message;button.disabled=false;}});action.append(button);}row.append(action);body.append(row);}table.hidden=false;status.textContent=`${subscriptions.length} negocios · ${usageData.pilots.length} con actividad de seguimiento.`;
 }catch(error){status.textContent=error.message;table.hidden=true;commercial.hidden=true;form.hidden=true;}
}
document.getElementById('commercial-filters').addEventListener('click',event=>{const button=event.target.closest('[data-filter]');if(!button)return;filter=button.dataset.filter;for(const b of document.querySelectorAll('[data-filter]'))b.setAttribute('aria-pressed',String(b===button));renderCommercial();});
form.addEventListener('submit',async event=>{event.preventDefault();const data=new FormData(form),businessId=data.get('businessId'),action=data.get('action'),name=subscriptions.find(b=>b.id===businessId)?.name;
 if(!name||data.get('confirmName')!==name){status.textContent='Escribe el nombre exacto del negocio para confirmar.';return;}
 const amount=data.get('amount'),payload={businessId,action,source:data.get('source'),startsAt:data.get('startsAt')?new Date(data.get('startsAt')).toISOString():null,endsAt:data.get('endsAt')?new Date(data.get('endsAt')).toISOString():null,amountCents:amount===''?null:Math.round(Number(amount)*100),note:data.get('note')};
 const button=form.querySelector('button[type=submit]');button.disabled=true;try{const response=await fetch('/api/admin/subscription-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw Error(result.error||'No pude guardar el acceso.');form.elements.confirmName.value='';await load();status.textContent=`Acceso de ${name} actualizado por el operador.`;}catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});
await load();
