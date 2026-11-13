import fs from 'node:fs';
import path from 'node:path';
import { build as bundleMain } from 'esbuild';
import { build as buildUI } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.resolve('desktop/pos-trial/bundle');
const ui = path.join(root,'ui');
fs.rmSync(root,{recursive:true,force:true});
fs.mkdirSync(root,{recursive:true});
const {metafile} = await bundleMain({entryPoints:['desktop/pos-trial/main.js'],outfile:path.join(root,'main.js'),
  bundle:true,platform:'node',target:'node22',format:'esm',external:['node:*','electron'],
  sourcemap:false,legalComments:'none',metafile:true});
// Fail the build if a new shared import would bring in a network client,
// production POS entry point, central database or Woo integration.
const shared = new Set(['desktop/store.js','desktop/contracts.js','server/errors.js',
  'server/passwords.js','server/sale-inputs.js','server/instance-lease.js']);
for(const entry of Object.keys(metafile.inputs)){
  const normalized=entry.replaceAll('\\','/');
  if(normalized.startsWith('node_modules/zod/')||normalized.startsWith('desktop/pos-trial/'))continue;
  if(!shared.has(normalized))throw new Error(`Forbidden dependency in practice main bundle: ${normalized}`);
}
const allowedExternal=new Set(['electron','node:fs','node:path','node:sqlite','node:crypto','node:url']);
for(const output of Object.values(metafile.outputs))for(const imported of output.imports){
  if(imported.external&&!allowedExternal.has(imported.path))throw new Error(`Forbidden practice runtime import: ${imported.path}`);
}
const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
if(/trading\.mansutrendzgh\.com|www\.mansutrendzgh\.com|electron-updater|["']node:https?["']/.test(main)){
  throw new Error('A live host, network client or updater leaked into the practice main bundle.');
}
fs.copyFileSync('desktop/pos-trial/preload.cjs',path.join(root,'preload.cjs'));
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({
  name:'mansu-pos-practice-not-for-sales',version:'0.1.0',private:true,
  description:'Isolated sample POS workflow. No real sales, Woo connection, payment or update feed.',
  author:'MansutRENDZGH',license:'UNLICENSED',type:'module',main:'main.js',
},null,2)+'\n');
await buildUI({configFile:false,root:path.resolve('src/pos-trial'),publicDir:false,base:'./',plugins:[react()],
  build:{outDir:ui,emptyOutDir:true,sourcemap:false,modulePreload:false,
    rollupOptions:{input:path.resolve('src/pos-trial/index.html')}}});
const html=fs.readFileSync(path.join(ui,'index.html'),'utf8');
if(!html.includes("connect-src 'none'")||!html.includes('NOT FOR SALES')||!html.includes('./assets/')){
  throw new Error('The practice renderer lost its visible safety label, no-network CSP or local assets.');
}
for(const name of fs.readdirSync(path.join(ui,'assets')).filter(entry=>entry.endsWith('.js'))){
  const code=fs.readFileSync(path.join(ui,'assets',name),'utf8');
  if(/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|trading\.mansutrendzgh\.com/.test(code)){
    throw new Error('A network client or live hostname leaked into the practice renderer.');
  }
}
console.log('POS Practice build: isolated main ledger/renderer, fake sync only, no trading client or live hostname.');
