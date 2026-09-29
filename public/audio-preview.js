// A PCM WAV preview stays in the browser; the original compressed recording is sent to the API.
export function wavPreview(parts,rate){
 const samples=parts.reduce((n,part)=>n+part.length,0),buffer=new ArrayBuffer(44+samples*2),view=new DataView(buffer);
 const label=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
 label(0,'RIFF');view.setUint32(4,36+samples*2,true);label(8,'WAVE');label(12,'fmt ');view.setUint32(16,16,true);
 view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);
 view.setUint16(32,2,true);view.setUint16(34,16,true);label(36,'data');view.setUint32(40,samples*2,true);
 let offset=44;for(const part of parts)for(const sample of part){const value=Math.max(-1,Math.min(1,sample));view.setInt16(offset,value<0?value*32768:value*32767,true);offset+=2;}
 return new Blob([buffer],{type:'audio/wav'});
}
