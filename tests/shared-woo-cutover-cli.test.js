import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadInStoreSnapshot } from '../server/instore-catalog.js';
import { renderSharedWooCutoverReadiness } from '../scripts/assess-shared-woo-cutover.mjs';
import { assessSharedWooInventoryCutover } from '../server/shared-woo-cutover-readiness.js';

const script=fileURLToPath(new URL('../scripts/assess-shared-woo-cutover.mjs',import.meta.url));
const csv='ID,Type,SKU,Name,Published,Visibility in catalog,Regular price,Stock,Tax status\n'
  +'900,simple,existing-web-only,SECRET WEBSITE PRODUCT,1,visible,999.99,777,none\n';
const sha=s=>createHash('sha256').update(s).digest('hex');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mansu-woo-cutover-cli-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const exportPath=path.join(dir,'woo-export.csv');
  const evidencePath=path.join(dir,'private-crosswalk.json');
  fs.writeFileSync(exportPath,csv,{mode:0o600});
  const data={
    schemaVersion:1,
    physicalManifestSha256:loadInStoreSnapshot().manifestHash,
    wooExportSha256:sha(csv),
    linkDrafts:[{sourceSku:'1434',target:'new_woo_required'}],
    cycleCounts:[],
  };
  fs.writeFileSync(evidencePath,JSON.stringify(data),{mode:0o600});
  const run=(args=[],env={})=>spawnSync(process.execPath,[script,...args],{
    cwd:dir,encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,...env},
  });
  return {dir,exportPath,evidencePath,run};
}
test('cutover offline CLI uses verified physical PDF/CSV and local Woo export; prints only aggregate blockers',t=>{
  const f=fixture(t);
  const before=fs.readdirSync(f.dir);
  const result=f.run([f.exportPath]);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stderr,'');
  assert.match(result.stdout,/OFFLINE READINESS REVIEW/);
  assert.match(result.stdout,/Historical physical source rows \| 1571/);
  assert.match(result.stdout,/Quarantined \/ held source rows \| 41/);
  assert.match(result.stdout,/identity_mapping_missing \| 1530/);
  assert.match(result.stdout,/fresh_two_person_count_missing \| 1530/);
  assert.match(result.stdout,/NO WOO IMPORT, PRODUCT CREATION, STOCK ADJUSTMENT/);
  assert.deepEqual(fs.readdirSync(f.dir),before,'CLI creates neither export nor import/stock-write file');
  for(const secret of ['SECRET WEBSITE PRODUCT','999.99','777','1434','existing-web-only',f.exportPath]) {
    assert.equal(result.stdout.includes(secret),false,secret+' leaked from private Woo export');
  }
});
test('optional source-hash-bound crosswalk plan still never becomes a Woo import or owner-approved link',t=>{
  const f=fixture(t);
  const result=f.run([f.exportPath,f.evidencePath]);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Proposed new-Woo identity assignments \(NOT created\) \| 1/);
  assert.match(result.stdout,/identity_mapping_missing \| 1529/);
  assert.match(result.stdout,/new_woo_product_identity_unassigned \| 1/);
  assert.doesNotMatch(result.stdout,/sourceSku|wooVariationId|Woo meta:/);
});
test('missing or malformed crosswalk, permissive private evidence and symlink inputs fail closed without leaking',t=>{
  const f=fixture(t);
  assert.equal(f.run([]).status,2);
  const wrong=f.run([f.exportPath,'not-an-evidence-file.json']);
  assert.equal(wrong.status,1);
  assert.match(wrong.stderr,/could not be verified/);
  assert.equal(wrong.stdout,'');
  fs.chmodSync(f.evidencePath,0o644);
  assert.equal(f.run([f.exportPath,f.evidencePath]).status,1);
  fs.chmodSync(f.evidencePath,0o600);
  const evidence=JSON.parse(fs.readFileSync(f.evidencePath,'utf8'));
  evidence.wooExportSha256='c'.repeat(64);
  fs.writeFileSync(f.evidencePath,JSON.stringify(evidence),{mode:0o600});
  const mismatch=f.run([f.exportPath,f.evidencePath]);
  assert.equal(mismatch.status,1);
  assert.equal(mismatch.stdout,'');
  const symlink=path.join(f.dir,'woo-symlink.csv');
  fs.symlinkSync(f.exportPath,symlink);
  assert.equal(f.run([symlink]).status,1);
});
test('renderer refuses a forged assessment claiming checkout/import rights',()=>{
  const physical={manifestHash:'a'.repeat(64),items:[]};
  const summary=assessSharedWooInventoryCutover({
    physical,wooExport:{rows:[]},wooExportSha256:'b'.repeat(64),
  });
  assert.match(renderSharedWooCutoverReadiness(summary),/BLOCKED: MANUAL PRODUCT IDENTITY/);
  assert.throws(()=>renderSharedWooCutoverReadiness({...summary,checkoutAuthorized:true}),/unsafe/);
  assert.throws(()=>renderSharedWooCutoverReadiness({...summary,uploadOrImportReady:true}),/unsafe/);
  assert.throws(()=>renderSharedWooCutoverReadiness({...summary,wooStockMutationsAllowed:true}),/unsafe/);
});
