import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('commercial pages keep the approved palette and visible account controls',async()=>{
 const landing=await readFile('public/index.html','utf8');
 const privacy=await readFile('public/privacy.html','utf8');
 const admin=await readFile('public/admin.html','utf8');
 const css=await readFile('public/style.css','utf8');
 for(const section of ['como-funciona','preguntas','landing','account','workspace','login','signup','onboarding','messages','record','voice-preview','admin-link'])assert.match(landing,new RegExp(`id="${section}"`));
 assert.match(landing,/Lleva las cuentas de tu negocio/);
 assert.match(landing,/hablando como siempre/);
 for(const html of [landing,privacy,admin])assert.doesNotMatch(html,/\b(piloto|demo|prueba|beta|experimental|Supabase|Gemini|CRM|API)\b/i);
 for(const color of ['#F6C992','#30525C','#ACC0D3','#D396A6','#09A1A1','#5484A4'])assert.ok(css.includes(color),`${color} missing`);
 assert.match(css,/100dvh/);
 assert.match(css,/safe-area-inset-bottom/);
});

test('installation manifest declares branded icons',async()=>{
 const manifest=JSON.parse(await readFile('public/manifest.webmanifest','utf8'));
 assert.equal(manifest.name,'Cuenta Clara');assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');
 for(const [size,file] of [[192,'public/icon-192.png'],[512,'public/icon-512.png']]){
  const bytes=await readFile(file);assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
 }
 assert.match(await readFile('public/index.html','utf8'),/rel="manifest"/);
});
