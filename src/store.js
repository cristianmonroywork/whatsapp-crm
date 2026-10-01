export class SupabaseStore {
  constructor(env=process.env,fetcher=fetch) {
    this.url=env.SUPABASE_URL; this.key=env.SUPABASE_SERVICE_ROLE_KEY; this.anon=env.SUPABASE_ANON_KEY; this.fetcher=fetcher;
    if(!this.url || !this.key || !this.anon) throw new Error('Supabase configuration missing');
  }
  async request(path,options={}) {
    const response=await this.fetcher(`${this.url}/rest/v1/${path}`,{...options,
      headers:{apikey:this.key,Authorization:`Bearer ${this.key}`,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(12000)});
    if(!response.ok) {
      const data=await response.json().catch(()=>({}));
      const e=new Error(data.code==='23505'?'Idempotency conflict':'Database request failed');
      e.status=data.code==='23505'?409:data.code==='42501'?403:503; throw e;
    }
    const text=await response.text();
    return text?JSON.parse(text):null;
  }
  rpc(name,body) {return this.request(`rpc/${name}`,{method:'POST',body:JSON.stringify(body)});}
  async membership(actor,business) {
    const rows=await this.request(`memberships?user_id=eq.${encodeURIComponent(actor)}&business_id=eq.${encodeURIComponent(business)}&select=businesses(is_active)`);
    return rows.length===1&&rows[0].businesses?.is_active===true;
  }
  async businesses(actor) {
    const memberships=await this.request(`memberships?user_id=eq.${encodeURIComponent(actor)}&select=businesses(id,name,timezone,is_pilot,is_active)`);
    return memberships.map(m=>m.businesses).filter(b=>b?.is_active);
  }
  async receipt(business,channel,id) {
    const rows=await this.request(`messages?business_id=eq.${encodeURIComponent(business)}&channel=eq.${channel}&external_id=eq.${encodeURIComponent(id)}&select=id,actor_id,fingerprint,response,media`);
    return rows[0];
  }
  process(args) {return this.rpc('process_command',args);}
  batch(args) {return this.rpc('process_batch',args);}
  inventory(args) {return this.rpc('process_inventory_message',args);}
  query(args) {return this.rpc('process_financial_query',args);}
  quota(actor,business,limits={}) {return business?this.rpc('consume_pilot_quota',{p_actor:actor,p_business:business,p_minute_limit:limits.perMinute||30,p_daily_limit:limits.perDay||250}):this.rpc('consume_quota',{p_actor:actor});}
  createPilotBusiness(actor,name,timezone) {return this.rpc('create_pilot_business',{p_actor:actor,p_name:name,p_timezone:timezone});}
  operator(actor) {return this.request(`pilot_operators?user_id=eq.${encodeURIComponent(actor)}&select=user_id`).then(rows=>rows.length===1);}
  dashboard(actor) {return this.rpc('pilot_dashboard',{p_actor:actor});}
  deactivatePilot(actor,business,name,phrase) {return this.rpc('deactivate_pilot_business',{p_actor:actor,p_business:business,p_expected_name:name,p_phrase:phrase});}
  async event(actor,business,type,code=null) {await this.request('pilot_events',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:actor,business_id:business,event_type:type,error_code:code})});}
  async presence(actor,business) {await this.request('pilot_presence?on_conflict=business_id,user_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({business_id:business,user_id:actor,last_seen_at:new Date().toISOString()})});}
  async binding(phone,sender) {
    const rows=await this.request(`channel_bindings?channel=eq.whatsapp&phone_number_id=eq.${encodeURIComponent(phone)}&sender_id=eq.${encodeURIComponent(sender)}&select=business_id,user_id`);
    return rows[0];
  }
  async enqueue(message,binding,text) {
    await this.request('outbox?on_conflict=message_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({message_id:message,business_id:binding.business_id,recipient:binding.sender,phone_number_id:binding.phone,body:text})});
  }
  claim(id) {return this.rpc('claim_delivery',{p_message:id});}
  async delivery(id) {return (await this.request(`outbox?message_id=eq.${id}&select=status`))[0];}
  markDelivery(id,patch) {return this.request(`outbox?message_id=eq.${id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(patch)});}
  async auth(path,{token,body}={}) {
    const res=await this.fetcher(`${this.url}/auth/v1/${path}`,{method:body?'POST':'GET',headers:{apikey:this.anon,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
    if(!res.ok) {const e=new Error(path==='signup'?'No se pudo crear la cuenta. Revisa los datos o intenta más tarde.':'Sesión inválida o credenciales incorrectas.');e.status=path==='signup'?400:401;throw e;}
    return res.json();
  }
}
