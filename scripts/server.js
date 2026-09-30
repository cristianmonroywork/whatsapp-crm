import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHandler} from '../api/index.js';
import {demoInterpret} from '../src/interpret.js';
const demo=(process.env.APP_MODE || 'demo')==='demo';
let handler;
if(demo) {
 const {createLocalStore,DEMO_USER}=await import('./local-store.js');
 const store=await createLocalStore('.local/db');await store.seed();
 handler=createHandler({store,interpreter:demoInterpret,demoUser:DEMO_USER});
} else handler=createHandler();
const files={'/':'index.html','/app.js':'app.js','/audio-preview.js':'audio-preview.js','/style.css':'style.css','/privacy.html':'privacy.html','/install.html':'install.html','/admin.html':'admin.html','/admin.js':'admin.js','/manifest.webmanifest':'manifest.webmanifest','/icon-192.png':'icon-192.png','/icon-512.png':'icon-512.png','/apple-touch-icon.png':'apple-touch-icon.png'};
createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path.startsWith('/api/')) return handler(req,res);
 if(!(path in files)) {res.writeHead(404);return res.end('No encontrado');}
 res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.png')?'image/png':path.endsWith('.webmanifest')?'application/manifest+json':'text/html; charset=utf-8');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
 res.end(await readFile(new URL(`../public/${files[path]}`,import.meta.url)));
}).listen(Number(process.env.PORT || 3000),'127.0.0.1',()=>console.log(`Vendixa: http://127.0.0.1:${process.env.PORT||3000} (${demo?'DEMO local, sin Gemini ni Supabase':'Supabase + Gemini'})`));
