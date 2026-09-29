import {createHash} from 'node:crypto';
import {parseBuffer} from 'music-metadata';

export const MAX_AUDIO_BYTES=3_000_000;
export const MAX_AUDIO_SECONDS=60;
const mimeTypes=new Map([
  ['audio/webm','audio/webm'],['audio/ogg','audio/ogg'],['audio/wav','audio/wav'],
  ['audio/x-wav','audio/wav'],['audio/wave','audio/wav'],['audio/mpeg','audio/mpeg'],
  ['audio/mp3','audio/mpeg'],['audio/mp4','audio/mp4'],['audio/x-m4a','audio/mp4'],
  ['audio/m4a','audio/mp4']
]);
const fail=(message,status)=>Object.assign(new Error(message),{status});
function signature(bytes,mime) {
  if(mime==='audio/wav') return bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WAVE';
  if(mime==='audio/ogg') return bytes.toString('ascii',0,4)==='OggS';
  if(mime==='audio/webm') return bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))&&bytes.subarray(0,4096).includes(Buffer.from('webm'));
  if(mime==='audio/mp4') return bytes.toString('ascii',4,8)==='ftyp';
  if(mime==='audio/mpeg') return bytes.toString('ascii',0,3)==='ID3'||(bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0);
  return false;
}
// MediaRecorder WebM frequently omits Segment Info/Duration. Read packet timestamps
// from its EBML structure instead of trusting a duration supplied by the browser.
export function webmDurationSeconds(bytes) {
  let scale=1_000_000,maxTicks=-1;
  function vint(pos,keepMarker=false) {
    const first=bytes[pos];if(!first)return null;
    let width=1,mask=0x80;while(width<=8&&!(first&mask)){width++;mask>>=1;}
    if(width>8||pos+width>bytes.length)return null;
    let value=BigInt(keepMarker?first:first&(mask-1));
    for(let i=1;i<width;i++)value=(value<<8n)|BigInt(bytes[pos+i]);
    const unknown=!keepMarker&&value===(1n<<BigInt(width*7))-1n;
    if(unknown)return {width,value:0,unknown:true};
    if(value>BigInt(Number.MAX_SAFE_INTEGER))return null;
    return {width,value:Number(value),unknown};
  }
  function unsigned(start,end) {if(end-start>8||end<=start)return null;let n=0;for(let i=start;i<end;i++)n=n*256+bytes[i];return n;}
  function scan(start,end,depth,clusterTime=0) {
    if(depth>5)return;
    for(let pos=start;pos<end;) {
      const id=vint(pos,true);if(!id)return;const size=vint(pos+id.width);if(!size)return;
      const data=pos+id.width+size.width;
      const next=size.unknown?end:data+size.value;
      if(next>end||next<=pos)return;
      const kind=id.value;
      if(kind===0x2ad7b1){const n=unsigned(data,next);if(n>0&&n<=1_000_000_000)scale=n;}
      if(kind===0xe7){const n=unsigned(data,next);if(n!==null)clusterTime=n;}
      if(kind===0xa3||kind===0xa1){const track=vint(data);const timePos=data+(track?.width||0);if(track&&timePos+2<=next){const relative=bytes.readInt16BE(timePos);maxTicks=Math.max(maxTicks,clusterTime+relative);}}
      if([0x18538067,0x1549a966,0x1f43b675,0xa0].includes(kind))scan(data,next,depth+1,kind===0x1f43b675?0:clusterTime);
      pos=next;
    }
  }
  scan(0,bytes.length,0);
  return maxTicks>=0 ? maxTicks*scale/1_000_000_000+0.12 : null;
}
export async function validateAudio(bytes,declaredMime) {
  if(!Buffer.isBuffer(bytes)||!bytes.length) throw fail('El audio está vacío.',400);
  if(bytes.length>MAX_AUDIO_BYTES) throw fail('El audio supera 3 MB.',413);
  const mime=mimeTypes.get(String(declaredMime||'').toLowerCase().split(';')[0].trim());
  if(!mime||!signature(bytes,mime)) throw fail('Formato de audio no aceptado.',415);
  let metadata;
  try {metadata=await parseBuffer(bytes,mime,{duration:true,skipCovers:true});} catch {throw fail('No pude leer el audio.',415);}
  const duration=metadata.format.duration??(mime==='audio/webm'?webmDurationSeconds(bytes):null);
  if(!Number.isFinite(duration)||duration<=0) throw fail('No pude comprobar la duración del audio.',422);
  if(duration>MAX_AUDIO_SECONDS) throw fail('El audio supera 60 segundos.',413);
  if(metadata.format.hasVideo) throw fail('Envía sólo audio.',415);
  return {mime,bytes:bytes.length,duration_seconds:Math.ceil(duration*100)/100,
    codec:metadata.format.codec||null,sha256:createHash('sha256').update(bytes).digest('hex')};
}

export async function transcribeAudio(bytes,{mime,key=process.env.GEMINI_API_KEY,model=process.env.GEMINI_TRANSCRIBE_MODEL||process.env.GEMINI_MODEL||'gemini-3.5-flash-lite',fetcher=fetch}={}) {
  if(!key) throw new Error('GEMINI_API_KEY missing');
  if(!/^gemini-[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid transcription model');
  const response=await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
    method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},signal:AbortSignal.timeout(25000),
    body:JSON.stringify({contents:[{role:'user',parts:[
      {text:'Transcribe literalmente esta nota de voz en español de México. Devuelve únicamente las palabras escuchadas, sin explicación, cálculos, correcciones ni operaciones financieras. Si no hay voz inteligible, devuelve una cadena vacía.'},
      {inlineData:{mimeType:mime,data:bytes.toString('base64')}}
    ]}],generationConfig:{maxOutputTokens:700,temperature:0}})
  });
  if(!response.ok) throw fail('No pude transcribir el audio. Reintenta con el mismo mensaje.',503);
  const data=await response.json();
  const candidate=data.candidates?.[0];
  if(data.promptFeedback?.blockReason||candidate?.finishReason==='SAFETY') return {text:'',provider:'gemini',model};
  if(!candidate||candidate.finishReason!=='STOP') throw fail('No pude transcribir el audio. Reintenta con el mismo mensaje.',503);
  const text=(candidate.content?.parts||[]).map(part=>part.text||'').join('').trim().replace(/^```(?:text)?\s*|\s*```$/g,'').trim();
  if(text.length>4000) throw fail('La transcripción es demasiado larga.',422);
  return {text,provider:'gemini',model};
}

export function multipleVoiceOperations(text) {
  const verbs=text.toLocaleLowerCase('es-MX').match(/(?:vend[ií]|saqu[eé][^.!?]{0,40}venta|gast[eé]|compr[eé]|me debe|me pag[oó]|cobr[eé]|recib[ií] un pago)/g);
  return (verbs?.length||0)>1;
}
