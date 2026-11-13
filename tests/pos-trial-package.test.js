import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve('desktop/pos-trial');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');

test('practice installer is a separate unsigned identity with only a bundled fake-ledger app and no publisher',()=>{
  const config=JSON.parse(read('builder.json'));
  const pos=JSON.parse(fs.readFileSync('package.json','utf8'));
  const hardware=JSON.parse(fs.readFileSync('desktop/hardware-test/builder.json','utf8'));
  assert.notEqual(config.appId,pos.build.appId);
  assert.notEqual(config.appId,hardware.appId);
  assert.equal(config.electronVersion,pos.devDependencies.electron);
  assert.equal(config.asar,true);
  assert.equal(config.npmRebuild,false);
  assert.deepEqual([...config.files].sort(),['main.js','preload.cjs','package.json','ui/**'].sort());
  assert.equal(config.publish,undefined);
  assert.equal(config.extraResources,undefined);
  assert.equal(config.extraFiles,undefined);
  assert.equal(config.nsis.perMachine,false);
  assert.match(config.productName,/Practice.*NOT FOR SALES/i);
  assert.match(config.nsis.artifactName,/PRACTICE-NOT-FOR-SALES/);
  assert.ok(fs.statSync(path.join(root,'practice.ico')).size>1000);
  assert.match(pos.scripts['dist:practice:win'],/--publish never/);
  assert.ok(pos.build.files.includes('!desktop/pos-trial/**'),'the selling installer must exclude all practice sources and bundles');
  assert.match(fs.readFileSync('.gitignore','utf8'),/desktop\/pos-trial\/bundle\//);
});

test('practice window never imports live network code or exposes selling operations via IPC',()=>{
  const main=read('main.js'),controller=read('controller.js'),preload=read('preload.cjs');
  const renderer=fs.readFileSync('src/pos-trial/PracticeApp.jsx','utf8');
  const html=fs.readFileSync('src/pos-trial/index.html','utf8');
  assert.match(main,/fs\.mkdirSync\(path\.join\(practiceDirectory,'session'\)/);
  assert.match(main,/app\.setPath\('userData'/);
  assert.match(main,/app\.setPath\('sessionData'/);
  assert.match(main,/safeStorage\.isEncryptionAvailable/);
  assert.match(main,/registerSchemesAsPrivileged/);
  assert.match(main,/protocol\.handle\('practice',localAsset\)/);
  assert.match(main,/onBeforeRequest/);
  assert.match(main,/nodeIntegration:false/);
  assert.match(main,/sandbox:true/);
  assert.match(main,/globalThis\.fetch\s*=/);
  assert.match(main,/trialSlip\(sale\)/);
  assert.match(preload,/contextBridge\.exposeInMainWorld\('mansuPractice'/);
  assert.doesNotMatch(preload,/\/api\/desktop\/(connect|allocate)|\/api\/auth\/login|mansuDesktop/);
  assert.match(controller,/practiceConfirmed/);
  assert.doesNotMatch(controller,/import\s+.*(?:desktopDispatch|DesktopRemote)/);
  assert.match(renderer,/NOT A RECEIPT/);
  assert.doesNotMatch(renderer,/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.match(html,/connect-src 'none'/);
  assert.doesNotMatch(html,/https?:\/\//i);
  assert.doesNotMatch(main,/from ['"]\.\.\/remote|from ['"]\.\.\/main|electron-updater/);
});
