import {readdir,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const directory of ['src','api','public','scripts','test']) {
 for(const file of await readdir(directory)) if(file.endsWith('.js')) {
  const result=spawnSync(process.execPath,['--check',`${directory}/${file}`],{encoding:'utf8'});
  if(result.status!==0) {console.error(result.stderr);process.exit(1);}
 }
}
const config=JSON.parse(await readFile('vercel.json','utf8'));
if(config.env.NODEJS_HELPERS!=='0') throw new Error('Webhook requires raw body');
const csp=config.headers.flatMap(item=>item.headers).find(item=>item.key.toLowerCase()==='content-security-policy')?.value||'';
if(!/(?:^|;)\s*media-src\s+[^;]*\bblob:/.test(csp)) throw new Error('Recorded-audio preview needs blob: in media-src');
for(const file of ['public/app.js','public/index.html','public/style.css']) {
 const source=await readFile(file,'utf8');
 if(/SUPABASE_SERVICE_ROLE_KEY|GEMINI_API_KEY|WHATSAPP_ACCESS_TOKEN/.test(source)) throw new Error(`Server key in ${file}`);
}
console.log('Syntax, Vercel raw body configuration and public-secret boundaries OK.');
