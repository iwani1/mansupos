import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listPackage, extractFile } from '@electron/asar';

try {
  const file=process.argv[2];
  if(!file||!fs.existsSync(file))throw new Error('Pass the Windows practice resources/app.asar for inspection.');
  const entries=listPackage(file).map(name=>name.replaceAll('\\','/').replace(/^\/+/,''));
  const expected=['main.js','preload.cjs','package.json','ui','ui/assets','ui/index.html'];
  const scripts=entries.filter(name=>/^ui\/assets\/[\w-]+\.js$/.test(name));
  const styles=entries.filter(name=>/^ui\/assets\/[\w-]+\.css$/.test(name));
  assert.equal(scripts.length,1,'Exactly one local renderer JS bundle is permitted.');
  assert.equal(styles.length,1,'Exactly one local renderer stylesheet is permitted.');
  assert.deepEqual([...entries].sort(),[...expected,...scripts,...styles].sort(),'Unexpected file in practice ASAR (possibly the selling POS, its server or a secret).');
  const content=name=>extractFile(file,name).toString();
  const manifest=JSON.parse(content('package.json'));
  assert.equal(manifest.main,'main.js');
  assert.equal(manifest.private,true);
  assert.deepEqual(manifest.dependencies||{},{});
  assert.deepEqual(manifest.devDependencies||{},{});
  assert.match(manifest.name,/practice-not-for-sales/);
  const main=content('main.js'),renderer=content(scripts[0]),preload=content('preload.cjs'),html=content('ui/index.html');
  assert.match(main,/PRACTICE-|NOT A RECEIPT/);
  assert.match(main,/Networking is disabled in POS Practice/);
  assert.match(main,/safeStorage\.isEncryptionAvailable/);
  assert.match(main,/onBeforeRequest/);
  assert.match(main,/practice:print/);
  assert.match(preload,/practice:request/);
  assert.match(html,/connect-src 'none'/);
  assert.match(renderer,/NOT A RECEIPT/);
  const leak=/trading\.mansutrendzgh\.com|www\.mansutrendzgh\.com|DesktopRemote|desktopDispatch|electron-updater|\/api\/desktop\/allocate|\bXMLHttpRequest\b|\bWebSocket\b|\bfetch\s*\(/i;
  for(const [label,text] of [['main',main],['renderer',renderer],['preload',preload],['html',html]]){
    if(leak.test(text))throw new Error(`${label} contains a live host, live operation, updater or HTTP client.`);
  }
  console.log('Packaged practice ASAR: exactly six local files, protected sample ledger, fake sync, no production transport, updater, Woo plugin or live hostname.');
}catch(error){
  const brief=String(error.message).replaceAll('%','%25').replace(/[\r\n]+/g,' | ').slice(0,900);
  console.error(`::error title=Practice package isolation::${brief}`);
  throw error;
}
