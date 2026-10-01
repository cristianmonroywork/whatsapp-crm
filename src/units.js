// Vocabulary only. Conversion and money arithmetic are performed with NUMERIC in SQL.
const aliases=new Map([
 ['pieza','pieza'],['piezas','pieza'],['unidad','pieza'],['unidades','pieza'],['cada uno','pieza'],['cada una','pieza'],
 ['kg','kg'],['kilo','kg'],['kilos','kg'],['kilogramo','kg'],['kilogramos','kg'],
 ['g','g'],['gramo','g'],['gramos','g'],
 ['tonelada','tonelada'],['toneladas','tonelada'],['ton','tonelada'],
 ['litro','litro'],['litros','litro'],['l','litro'],
 ['ml','ml'],['mililitro','ml'],['mililitros','ml'],
 ['caja','caja'],['cajas','caja'],['paquete','paquete'],['paquetes','paquete'],
 ['costal','costal'],['costales','costal'],['docena','docena'],['docenas','docena']
]);
export const normalizeUnit=value=>value==null?null:aliases.get(String(value).trim().toLocaleLowerCase('es-MX'))||null;
export const quantityString=value=>{
 const text=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;
 if(typeof text!=='string'||!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/.test(text)||!/[1-9]/.test(text)) return null;
 return text;
};
export const readableQuantity=value=>String(value).replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1');
export const unitLabel=(unit,quantity)=>{
 const single={pieza:'pieza',kg:'kg',g:'g',tonelada:'tonelada',litro:'litro',ml:'ml',caja:'caja',paquete:'paquete',costal:'costal',docena:'docena'}[unit]||unit||'pieza';
 if(['kg','g','ml'].includes(single)||String(quantity)==='1') return single;
 return ({tonelada:'toneladas',litro:'litros',pieza:'piezas',caja:'cajas',paquete:'paquetes',costal:'costales',docena:'docenas'})[single]||single;
};
