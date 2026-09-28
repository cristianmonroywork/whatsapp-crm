const allowed=new Set(['sale','expense','receivable','payment','totals','balance','correct_last','delete_last','clarify']);
export function cents(value) {
  if(typeof value!=='string' || !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value)) throw new Error('Invalid monetary amount');
  const [whole, fraction='']=value.split('.');
  const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(result) || result<1 || result>100000000000) throw new Error('Amount out of range');
  return result;
}
export function control(text) {
  const confirmation=text.trim().match(/^CONFIRMAR ([A-F0-9]{10})$/i);
  if(confirmation) return {intent:'confirm',token:confirmation[1].toUpperCase()};
  if(/^cancelar$/i.test(text.trim())) return {intent:'cancel'};
  return null;
}
export function normalize(raw) {
  if(!raw || !allowed.has(raw.intent) || typeof raw.ambiguous!=='boolean') return {intent:'clarify'};
  if(raw.ambiguous || raw.intent==='clarify') return {intent:'clarify'};
  const date=raw.date;
  if(!['today','yesterday'].includes(date)) {
    if(typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return {intent:'clarify'};
    const parsed=new Date(`${date}T12:00:00Z`);
    if(!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10)!==date || Number(date.slice(0,4))<2000) return {intent:'clarify'};
  }
  if(!['day','week','month','all'].includes(raw.period)) return {intent:'clarify'};
  const out={intent:raw.intent,date,period:raw.period};
  if(raw.contact!==null) {
    if(typeof raw.contact!=='string' || !raw.contact.trim() || raw.contact.length>120) return {intent:'clarify'};
    out.contact=raw.contact.trim().normalize('NFC');
  }
  if(raw.description!==null) {
    if(typeof raw.description!=='string' || raw.description.length>240) return {intent:'clarify'};
    out.description=raw.description;
  }
  if(['sale','expense','receivable','payment','correct_last'].includes(out.intent)) {
    try {
      if(raw.amount!==null && raw.unit_price!==null) return {intent:'clarify'};
      if(raw.amount!==null) out.amount_cents=cents(raw.amount);
      else {
        if(!['sale','expense'].includes(out.intent) || !Number.isSafeInteger(raw.quantity) || raw.quantity<1 || raw.quantity>100000) return {intent:'clarify'};
        out.amount_cents=cents(raw.unit_price)*raw.quantity;
        if(!Number.isSafeInteger(out.amount_cents)||out.amount_cents>100000000000) return {intent:'clarify'};
      }
    } catch { return {intent:'clarify'}; }
  }
  if(['receivable','payment'].includes(out.intent)&&!out.contact) return {intent:'clarify'};
  return out;
}
export const money = n => new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN',maximumFractionDigits:2}).format(Number(n)/100);
const kinds={sale:'Venta',expense:'Gasto',receivable:'Cuenta por cobrar',payment:'Pago'};
export function render(r) {
  switch(r.status) {
    case 'recorded': return `${kinds[r.kind]} registrada: ${money(r.amount_cents)} MXN.${r.kind==='payment'?` Saldo pendiente: ${money(r.balance_cents)} MXN.`:''}`;
    case 'totals': return `Del ${r.from} al ${r.to}:\nVentas: ${money(r.sales_cents)} MXN.\nGastos: ${money(r.expenses_cents)} MXN.\nCobros de cuentas: ${money(r.payments_cents)} MXN. Los cobros no se suman otra vez a las ventas.`;
    case 'balance': return `Te deben ${money(r.balance_cents)} MXN.`;
    case 'confirmation': return `${r.action==='delete_last'?'Anular':'Corregir'} tu último movimiento: ${kinds[r.kind]}, ${money(r.old_amount_cents)} MXN, ${r.date}${r.description?` (${r.description})`:''}.${r.action==='correct_last'?` Nuevo importe: ${money(r.new_amount_cents)} MXN.`:''}\nPara aplicar, escribe CONFIRMAR ${r.token}. Caduca en 10 minutos. O escribe CANCELAR.`;
    case 'changed': return r.action==='delete_last'?'Movimiento anulado. Conservé su historial.':`Movimiento corregido a ${money(r.amount_cents)} MXN. Conservé el importe anterior en el historial.`;
    case 'cancelled': return 'Cancelado. No cambié tus movimientos.';
    case 'clarify': return ({no_debt:'No encontré una cuenta pendiente con ese nombre. No registré el pago.',multiple_debts:'Ese cliente tiene varias cuentas pendientes. No registré el pago; por ahora este MVP requiere una sola cuenta abierta por cliente.',overpayment:`El importe supera el saldo disponible (${money(r.balance_cents || 0)} MXN). No cambié el registro.`,no_last:'Todavía no tienes movimientos que corregir o anular.',expired:'Ese código no existe, ya se usó o caducó. Vuelve a solicitar la corrección o anulación.',changed:'El movimiento cambió desde la solicitud. Vuelve a solicitar la corrección o anulación.',linked_payments:'La cuenta tiene pagos vinculados. No puedo anularla ni reducirla por debajo de lo pagado.'})[r.reason] || 'Necesito un movimiento claro por mensaje, con importe y cliente cuando corresponda. Por ejemplo: “Vendí 3 playeras en $900”, “Pedro me debe $600” o “Pedro me pagó $300”. Para una corrección: “Corrige el último a $800”. No registré cambios.';
    default: throw new Error('Unknown result');
  }
}
