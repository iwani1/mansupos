#!/usr/bin/env node
// OFFLINE checksum verifier for Phase 5.9 metadata-only inventory evidence.
// It checks an externally retained SHA-256 against canonical JSON contents.
// It CANNOT establish the author, physical count accuracy or reviewer identity.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

function canonical(value){
  function normalize(v){
    if(Array.isArray(v))return v.map(normalize);
    if(v&&typeof v==='object'){
      const out={};
      for(const k of Object.keys(v).sort()){
        if(v[k]===undefined)throw new Error('Undefined object field');
        out[k]=normalize(v[k]);
      }
      return out;
    }
    if(v===null||typeof v==='string'||typeof v==='boolean'||
      typeof v==='number'&&Number.isFinite(v))return v;
    throw new Error('Invalid canonical field type');
  }
  return JSON.stringify(normalize(value));
}
function main(){
  const [path,expected]=process.argv.slice(2);
  if(!path||!/^[a-f0-9]{64}$/.test(expected||'')){
    process.stderr.write('Usage: node scripts/verify-inventory-audit-handoff.mjs <manifest.json> <SHA-256-saved-separately>\n');
    process.exitCode=2;return;
  }
  try{
    const bytes=readFileSync(path);
    if(bytes.length>3*1024*1024)throw new Error('Manifest exceeds safe size limit.');
    const artifact=JSON.parse(bytes.toString('utf8'));
    if(artifact?.kind!=='owner-inventory-audit-handoff'||
      artifact.content?.format!=='mansupos-inventory-audit-handoff-v1'||
      artifact.auditOnly!==true||artifact.metadataOnly!==true||
      artifact.stockImportAuthorized!==false||artifact.checkoutAuthorized!==false||
      artifact.paymentsAuthorized!==false||artifact.inventoryAccepted!==false||
      artifact.releaseReady!==false||
      !Array.isArray(artifact.content.items)||
      !Array.isArray(artifact.content.globalRequirements)||
      artifact.content.auditOnly!==true||artifact.content.metadataOnly!==true||
      artifact.content.stockImportAuthorized!==false||
      artifact.content.checkoutAuthorized!==false||
      artifact.content.paymentsAuthorized!==false||
      artifact.content.inventoryAccepted!==false||
      artifact.content.releaseReady!==false||
      artifact.content.summary?.acceptedRows!==0||
      artifact.content.summary?.approvedForImport!==0||
      artifact.content.items.length!==artifact.content.summary?.historicalRows||
      artifact.content.globalRequirements.some(x=>x.verified!==false)||
      artifact.content.items.some(x=>
        x.physicalStockVerified!==false||x.releaseReady!==false||
        x.acceptedUnits!==null||
        !Array.isArray(x.requirements)||
        x.requirements.some(r=>r.independentlyVerified!==false)))
      throw new Error('Manifest format or non-approval safety fields are invalid.');
    const computed=createHash('sha256')
      .update(canonical(artifact.content),'utf8').digest('hex');
    if(artifact.sha256!==computed||expected!==computed)
      throw new Error('SHA-256 MISMATCH: contents do not match the separately saved reference.');
    process.stdout.write('CHECKSUM MATCH: JSON contents match the separately recorded SHA-256.\n');
    process.stdout.write('NOT A SIGNATURE, VERIFIED HUMAN IDENTITY, PHYSICAL COUNT OR STOCK APPROVAL.\n');
  }catch(e){
    process.stderr.write('VERIFICATION FAILED: '+e.message+'\n');
    process.exitCode=1;
  }
}
main();
