import {createHash} from 'node:crypto';
import {AppError} from './errors.js';
import {buildInventoryVerificationReadiness} from './inventory-verification-readiness.js';

// Phase 5.9. Offline handoff of MINIMIZED, non-approving evidence metadata.
// A SHA-256 checksum detects alteration relative to a previously retained
// trusted reference; it is NOT a digital signature or independent attestation.
const sha=/^[a-f0-9]{64}$/;
const MAX_ROWS=5000;
const MAX_BYTES=2*1024*1024;
const locked=Object.freeze({
  auditOnly:true,metadataOnly:true,releaseReady:false,
  independentlyAuthenticatedWitness:false,
  originalDocumentAuthenticityVerified:false,
  signedCurrentPhysicalCountVerified:false,
  mappingApproved:false,ownerApproved:false,
  inventoryAccepted:false,approvedCases:0,
  stockImportAuthorized:false,checkoutAuthorized:false,
  paymentsAuthorized:false,
});
function ownerOnly(user){
  if(user?.role!=='owner')throw new AppError(
    'Only the Owner can export the independent inventory audit handoff.',403,
    'AUDIT_HANDOFF_OWNER_ONLY');
}
// One deterministic canonical representation for both Node and browser
// verifiers; no timestamps, personal identifiers, secret or document bytes.
export function canonicalEvidenceJSON(value){
  function normalize(v){
    if(Array.isArray(v))return v.map(normalize);
    if(v&&typeof v==='object'){
      const result={};
      for(const key of Object.keys(v).sort()){
        if(v[key]===undefined)throw new AppError('Undefined export field.',409,
          'AUDIT_HANDOFF_INVALID_PAYLOAD');
        result[key]=normalize(v[key]);
      }
      return result;
    }
    if(v===null||typeof v==='string'||typeof v==='boolean'||
      typeof v==='number'&&Number.isFinite(v))return v;
    throw new AppError('Invalid export field.',409,'AUDIT_HANDOFF_INVALID_PAYLOAD');
  }
  return JSON.stringify(normalize(value));
}
const digest=value=>createHash('sha256')
  .update(canonicalEvidenceJSON(value),'utf8').digest('hex');

export class InventoryAuditHandoff{
  constructor(mappingEvidence,countClaims,exceptions,reconciliationPackets){
    this.mappingEvidence=mappingEvidence;
    this.countClaims=countClaims;
    this.exceptions=exceptions;
    this.reconciliationPackets=reconciliationPackets;
  }
  build(user,physical,website,clock=Date.now()){
    ownerOnly(user);
    const rows=[],packetRows=[];
    const readiness=buildInventoryVerificationReadiness(
      physical,website,this.mappingEvidence,this.countClaims,this.exceptions,
      user,{page:1,pageSize:1},clock,rows);
    const reconciliation=this.reconciliationPackets.listOwner(
      user,physical,website,{page:1,pageSize:1},clock,packetRows);
    if(readiness.auditOnly!==true||readiness.releaseReady!==false||
      readiness.stockImportAuthorized!==false||
      reconciliation.auditOnly!==true||reconciliation.provisionalOnly!==true||
      reconciliation.stockImportAuthorized!==false||
      readiness.readinessRef!==reconciliation.readinessRef||
      !sha.test(readiness.readinessRef||'')||
      !sha.test(reconciliation.snapshotRef||'')||
      !sha.test(readiness.sourceHash||'')||
      rows.length!==readiness.summary.totalHistoricalRows||
      packetRows.length!==reconciliation.summary.historicalRows||
      rows.length!==packetRows.length||
      rows.length>MAX_ROWS){
      throw new AppError('Complete trusted stock audit evidence is not available.',
        409,'AUDIT_HANDOFF_INCOMPLETE');
    }
    const packetMap=new Map();
    for(const packet of packetRows){
      if(!Number.isSafeInteger(packet.reportRow)||packet.reportRow<1||
        packetMap.has(packet.reportRow))
        throw new AppError('Duplicate packet source identity in audit evidence.',409,
          'AUDIT_HANDOFF_DUPLICATE_ROW');
      packetMap.set(packet.reportRow,packet);
    }
    const items=rows.map(row=>{
      const packet=packetMap.get(row.reportRow);
      if(!packet||packet.sku!==row.sku||
        packet.rowEvidenceRef!==row.evidenceRef||
        row.stockImportAuthorized!==false||row.checkoutAuthorized!==false||
        row.readiness!=='blocked'||packet.readiness!=='blocked'){
        throw new AppError('Physical count, dossier or packet snapshot changed.',
          409,'AUDIT_HANDOFF_ROW_MISMATCH');
      }
      const latest=packet.latestPacket;
      return {
        reportRow:row.reportRow,sku:row.sku,
        evidenceRef:row.evidenceRef,reviewPriority:row.priority,
        staffCountDiscrepancyOpen:row.staffCountDiscrepancyOpen,
        evidenceFlags:row.exceptionFlags,
        requirements:row.criteria.map(x=>({
          id:x.id,status:x.state,independentlyVerified:false,
        })),
        assignedReviewerAccounts:packet.availableGrants.length,
        latestProvisionalPacket:latest?{
          id:latest.id,status:latest.status,
          intent:latest.intent,
          reviewerAccountFinding:latest.latestResponse?.finding??null,
        }:null,
        physicalStockVerified:false,
        acceptedUnits:null,
        releaseReady:false,
      };
    });
    const content={
      format:'mansupos-inventory-audit-handoff-v1',
      evidenceClass:'unverified-metadata-not-independent-audit',
      sourceHash:readiness.sourceHash,
      dossierRef:readiness.dossierRef,
      exceptionRef:readiness.exceptionRef,
      readinessRef:readiness.readinessRef,
      reconciliationRef:reconciliation.snapshotRef,
      globalRequirements:readiness.globalRequirements.map(x=>({
        id:x.id,verified:false,source:x.source,
      })),
      summary:{
        historicalRows:items.length,
        disputedRows:items.filter(x=>x.staffCountDiscrepancyOpen).length,
        acceptedRows:0,approvedForImport:0,
      },
      items,
      // These control fields are part of the hashed content, not UI promises.
      ...locked,
    };
    const canonical=canonicalEvidenceJSON(content);
    if(Buffer.byteLength(canonical,'utf8')>MAX_BYTES)
      throw new AppError('Export exceeds safe size limits; investigate offline in smaller, independently controlled evidence batches.',
        409,'AUDIT_HANDOFF_TOO_LARGE');
    return {
      kind:'owner-inventory-audit-handoff',
      checksumAlgorithm:'SHA-256 over recursively sorted-key compact JSON UTF-8 of content',
      sha256:digest(content),
      content,
      ...locked,
      notice:'Metadata-only offline evidence handoff. SHA-256 is NOT a signature, human identity proof, external witness attestation, accepted physical count or approval for Woo/POS stock.',
    };
  }
}
