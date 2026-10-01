import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('commercial pages keep the Vendixa palette and visible account controls',async()=>{
 const landing=await readFile('public/index.html','utf8');
 const privacy=await readFile('public/privacy.html','utf8');
 const admin=await readFile('public/admin.html','utf8');
 const css=await readFile('public/style.css','utf8');
 for(const section of ['como-funciona','preguntas','landing','account','workspace','login','signup','onboarding','messages','record','voice-preview','admin-link','mobile-menu-toggle','mobile-menu','mobile-admin-link','mobile-logout'])assert.match(landing,new RegExp(`id="${section}"`));
 assert.match(landing,/Lleva las cuentas de tu negocio/);
 assert.match(landing,/hablando como siempre/);
 assert.match(landing,/aria-expanded="false"/);
 assert.match(landing,/id="mobile-admin-link"[^>]*hidden/);
 assert.match(await readFile('public/app.js','utf8'),/\$\('mobile-logout'\)\.addEventListener\('click',logout\)/);
 const install=await readFile('public/install.html','utf8');
 assert.match(install,/Agregar a pantalla de inicio/);
 for(const html of [landing,privacy,admin,install])assert.doesNotMatch(html,/\b(piloto|demo|prueba|beta|experimental|Supabase|Gemini|CRM|API)\b/i);
 for(const html of [landing,privacy,admin,install]){
  assert.match(html,/<meta name="apple-mobile-web-app-title" content="Vendixa">/);
  assert.match(html,/<meta property="og:site_name" content="Vendixa">/);
  assert.doesNotMatch(html,/Cuenta Clara|cuenta clara|CUENTA CLARA/);
 }
 for(const color of ['#FF004F','#FFDD00','#F7D046','#222222','#717171','#E1E1E1','#E5E7EB','#FAF8F0','#1877F2'])assert.ok(css.includes(color),`${color} missing`);
 for(const color of ['#D8573F','#30525C','#09A1A1','#F6C992'])assert.ok(!css.includes(color),`${color} remains in CSS`);
 for(const html of [landing,privacy,admin,install])assert.match(html,/<meta name="theme-color" content="#FF004F">/);
 assert.match(css,/\.primary,.send-main,.mic-main,.voice-actions #send-audio\{background:var\(--brand-primary\);color:var\(--on-primary\)/);
 assert.match(css,/\.chat-area \.bubble\.error\{background:var\(--error-surface\);color:var\(--error-text\)/);
 assert.match(css,/100dvh/);
 assert.match(css,/safe-area-inset-bottom/);
});

test('installation manifest declares branded icons',async()=>{
 const manifest=JSON.parse(await readFile('public/manifest.webmanifest','utf8'));
 assert.equal(manifest.name,'Vendixa');assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');
 assert.equal(manifest.short_name,'Vendixa');
 assert.equal(manifest.description,'Registra ventas, gastos y cuentas por cobrar por texto o voz y consulta cómo va tu negocio.');
 assert.equal(manifest.theme_color,'#FF004F');assert.equal(manifest.background_color,'#FAF8F0');
 for(const [size,file] of [[192,'public/icon-192.png'],[512,'public/icon-512.png']]){
  const bytes=await readFile(file);assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a');assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
 }
 assert.match(await readFile('public/index.html','utf8'),/rel="manifest"/);
 for(const file of ['public/apple-touch-icon.png','public/favicon-32.png','public/og-vendixa.png']){
  const bytes=await readFile(file);assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a');
 }
});

test('primary and yellow buttons use legible text colors',()=>{
 const luminance=hex=>{
  const parts=hex.match(/[A-Fa-f0-9]{2}/g).map(value=>parseInt(value,16)/255);
  const [r,g,b]=parts.map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
  return 0.2126*r+0.7152*g+0.0722*b;
 };
 const contrast=(a,b)=>{
  const first=luminance(a),second=luminance(b);
  return (Math.max(first,second)+0.05)/(Math.min(first,second)+0.05);
 };
 assert.ok(contrast('#FF004F','#111111')>=4.5);
 assert.ok(contrast('#FFDD00','#222222')>=4.5);
 assert.ok(contrast('#B60038','#FAF8F0')>=4.5);
});
