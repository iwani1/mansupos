import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './errors.js';
import { audit } from './db.js';
import { listPhysicalMappingCoverage } from './physical-mapping-coverage.js';

// Owner-proposed product identities are LOCAL REVIEW EVIDENCE, never
// verified mappings or permission to import or sell WooCommerce stock.
const hashRef=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decisions=['propose_option','investigate_identity','retain_hold'];
const normalize=x=>typeof x==='string'?x.trim().toUpperCase():'';
const safeId=x=>Number.isSafeInteger(x)&&x>0;
const sha=data=>createHash('sha256').update(JSON.stringify(data)).digest('hex');

export const ownerMappingSchema=z.object({
  reportRow:z.number().int().min(1).max(10000),
  expectedRef:z.string().regex(hashRef),
  expectedLatestReviewId:z.number().int().positive().nullable(),
  decision:z.enum(decisions),
  proposedProductId:z.number().int().positive().nullable(),
  proposedVariationId:z.number().int().positive().nullable(),
  note:z.string().trim().min(8).max(240)
    .refine(value=>!/[\r\n]/.test(value),'Notes must be one line.'),
  requestId:z.string().regex(uuid),
}).strict();

function publishedOptions(website){
  const options=[];
  for(const product of Array.isArray(website?.products)?website.products:[]){
    if(product?.type==='simple'){
      options.push({
        productId:product.id,variationId:null,sku:normalize(product.sku),
        kind:'simple',
      });
    }else if(product?.type==='variable'){
      for(const v of Array.isArray(product.variations)?product.variations:[]){
        options.push({
          productId:product.id,variationId:v?.id,sku:normalize(v?.sku),
          kind:'variation',
        });
      }
    }
  }
  return options;
}
function identityKey(productId,variationId){
  return String(productId)+':'+String(variationId??0);
}
function readReviews(db){
  const list=[];
  for(const event of db.prepare(
    "SELECT id,actor,subject,created_at FROM audit WHERE action='inventory.owner_mapping_review' ORDER BY id ASC"
  ).all()){
    let d;
    try{d=JSON.parse(event.subject);}catch{continue;}
    if(d?.schemaVersion!==1||!hashRef.test(d.sourceHash||'')||
       !hashRef.test(d.identityRef||'')||
       !Number.isSafeInteger(d.reportRow)||d.reportRow<1||
       !decisions.includes(d.decision)||!uuid.test(d.requestId||'')||
       typeof d.note!=='string'||d.note.length<8||d.note.length>240||
       !(d.proposedProductId===null||safeId(d.proposedProductId))||
       !(d.proposedVariationId===null||safeId(d.proposedVariationId))||
       (d.decision==='propose_option'&&!safeId(d.proposedProductId)))continue;
    list.push({...d,id:event.id,actor:event.actor,recordedAt:event.created_at});
  }
  return list;
}

function context(physical,website,clock){
  const rows=[];
  const mapping=listPhysicalMappingCoverage(physical,website,
    {page:1,pageSize:1},clock,rows);
  const options=publishedOptions(website);
  const identityRef=sha({
    sourceHash:mapping.physicalManifestSha256,
    rows:rows.map(r=>({
      reportRow:r.reportRow,sku:r.sku,status:r.status,
      productId:r.productId,variationId:r.variationId,
    })),
    // A missing/different unpublished option or duplicated Woo identity
    // must invalidate older proposals even if physical row statuses match.
    websiteOptions:options.map(o=>({
      productId:o.productId,variationId:o.variationId,
      sku:o.sku,kind:o.kind,
    })),
  });
  return {rows,mapping,options,identityRef};
}
function latestFor(reviews,sourceHash,identityRef){
  const latest=new Map();
  for(const r of reviews){
    if(r.sourceHash===sourceHash&&r.identityRef===identityRef)
      latest.set(r.reportRow,r);
  }
  return latest;
}
function view(row,latest){
  return {
    reportRow:row.reportRow,sku:row.sku,
    classification:row.status,
    initialProductId:row.productId,
    initialVariationId:row.variationId,
    latestReview:latest?{
      id:latest.id,decision:latest.decision,note:latest.note,
      proposedProductId:latest.proposedProductId,
      proposedVariationId:latest.proposedVariationId,
      proposedSku:latest.proposedSku||null,
      exactSkuMatch:latest.exactSkuMatch===true,
      actor:latest.actor,recordedAt:latest.recordedAt,
      // A stored proposal remains ONLY a human claim.
      mappingApproved:false,
    }:null,
    mappingApproved:false,
    stockImportAuthorized:false,
  };
}

export class OwnerMappingEvidence {
  constructor(db){this.db=db;}

  review(physical,website,query={},clock=Date.now(),collectRows=null){
    const {page=1,pageSize=25,search='',status='all'}=query;
    if(!Number.isSafeInteger(page)||page<1||page>10000||
       !Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50||
       typeof search!=='string'||search.length>64||
       !['all','not_reviewed','proposed','investigation','hold'].includes(status))
      throw new AppError('Invalid mapping evidence filters.',400,'INVALID_MAPPING_EVIDENCE_FILTER');
    const {rows,mapping,identityRef}=context(physical,website,clock);
    const latest=latestFor(readReviews(this.db),mapping.physicalManifestSha256,identityRef);
    const counts={notReviewed:0,proposed:0,investigation:0,hold:0};
    const all=rows.map(row=>{
      const review=latest.get(row.reportRow);
      const item=view(row,review);
      const key=review?.decision==='propose_option'?'proposed':
        review?.decision==='investigate_identity'?'investigation':
        review?.decision==='retain_hold'?'hold':'notReviewed';
      counts[key]++;
      return {item,key};
    });
    if(Array.isArray(collectRows))collectRows.push(...all.map(x=>x.item));
    const needle=normalize(search);
    const filtered=all.filter(({item,key})=>
      (status==='all'||(status==='not_reviewed'?'notReviewed':status)===key)&&
      (!needle||normalize(item.sku).includes(needle)||
        String(item.reportRow).includes(needle)||
        String(item.latestReview?.proposedProductId??'').includes(needle)||
        String(item.latestReview?.proposedVariationId??'').includes(needle))
    );
    const total=filtered.length,pages=Math.max(1,Math.ceil(total/pageSize));
    return {
      kind:'local-owner-mapping-evidence-review',auditOnly:true,
      checkoutAuthorized:false,stockImportAuthorized:false,
      mappingApproved:false,sharedStockVerified:false,
      evidenceVerified:mapping.evidenceVerified,
      sourceHash:mapping.physicalManifestSha256,
      identityRef,
      counts,page,pageSize,pages,total,hasMore:page<pages,
      items:filtered.slice((page-1)*pageSize,page*pageSize).map(x=>x.item),
      notice:'Owner mapping PROPOSALS only: no independent colour/size or stock verification, no Woo updates, no stock imports, no checkout.',
    };
  }

  submit(user,physical,website,raw,clock=Date.now()){
    if(user?.role!=='owner')
      throw new AppError('Only the Owner may add mapping investigation notes.',403,'MAPPING_OWNER_REQUIRED');
    const values=ownerMappingSchema.parse(raw);
    const {rows,mapping,options,identityRef}=context(physical,website,clock);
    if(!mapping.evidenceVerified||!hashRef.test(mapping.physicalManifestSha256||''))
      throw new AppError('Signed source or Woo catalogue incomplete/stale; no mapping note recorded.',409,'MAPPING_EVIDENCE_STALE');
    if(values.expectedRef!==identityRef)
      throw new AppError('Stock source or published Woo options changed; reload review.',409,'MAPPING_EVIDENCE_CHANGED');
    // Fail closed if legacy physical rows share a report row identity.
    if(rows.filter(r=>r.reportRow===values.reportRow).length!==1)
      throw new AppError('Historical row identifier is missing or duplicated.',409,'MAPPING_ROW_AMBIGUOUS');
    const sourceRow=rows.find(r=>r.reportRow===values.reportRow);
    if(!sourceRow)throw new AppError('No such historical source row.',404,'MAPPING_ROW_NOT_FOUND');
    if(values.decision!=='propose_option' &&
       (values.proposedProductId!==null||values.proposedVariationId!==null))
      throw new AppError('Only a provisional option proposal may contain Woo IDs.',400,'MAPPING_UNEXPECTED_IDS');
    let proposed=null;
    if(values.decision==='propose_option'){
      if(['held','missing_physical_sku','duplicate_physical_sku',
          'ambiguous_website_identity'].includes(sourceRow.status))
        throw new AppError('This item has an unresolved identity/hold and cannot receive a proposed link.',409,'MAPPING_SOURCE_HELD');
      const candidates=options.filter(o=>o.productId===values.proposedProductId&&
        o.variationId===values.proposedVariationId);
      if(candidates.length!==1||!safeId(candidates[0].productId)||
         candidates[0].kind==='variation'&&!safeId(candidates[0].variationId))
        throw new AppError('Proposed ID is not one unique published Woo product option.',409,'MAPPING_OPTION_NOT_UNIQUE');
      proposed=candidates[0];
      if(!proposed.sku)
        throw new AppError('A Woo option without an SKU cannot be proposed.',409,'MAPPING_OPTION_SKU_MISSING');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const reviews=readReviews(this.db);
      const replay=reviews.find(r=>r.requestId===values.requestId);
      if(replay){
        const identical=replay.actor===user.id&&
          replay.sourceHash===mapping.physicalManifestSha256&&
          replay.identityRef===identityRef&&
          replay.reportRow===values.reportRow&&
          replay.decision===values.decision&&
          replay.proposedProductId===values.proposedProductId&&
          replay.proposedVariationId===values.proposedVariationId&&
          replay.note===values.note;
        if(!identical)throw new AppError('This request identifier was already used for different evidence.',409,'MAPPING_REPLAY_CONFLICT');
        this.db.exec('COMMIT');
        return {
          kind:'local-unverified-owner-mapping-proposal',recorded:true,
          replayed:true,reviewId:replay.id,auditOnly:true,
          mappingApproved:false,checkoutAuthorized:false,stockImportAuthorized:false,
        };
      }
      const latest=latestFor(reviews,mapping.physicalManifestSha256,identityRef);
      const prior=latest.get(values.reportRow);
      if(values.expectedLatestReviewId!==(prior?.id??null))
        throw new AppError('A newer owner review exists; reload this record.',409,'MAPPING_REVIEW_CHANGED');
      if(proposed){
        const duplicate=[...latest.entries()].find(([rowId,entry])=>
          rowId!==values.reportRow&&entry.decision==='propose_option'&&
          identityKey(entry.proposedProductId,entry.proposedVariationId)===
            identityKey(proposed.productId,proposed.variationId));
        if(duplicate)
          throw new AppError('Another physical row already proposes this exact Woo option; investigate the duplicate.',409,'MAPPING_OPTION_ALREADY_PROPOSED');
      }
      audit(this.db,user.id,'inventory.owner_mapping_review',JSON.stringify({
        schemaVersion:1,
        sourceHash:mapping.physicalManifestSha256,identityRef,
        reportRow:values.reportRow,decision:values.decision,
        proposedProductId:values.proposedProductId,
        proposedVariationId:values.proposedVariationId,
        proposedSku:proposed?.sku||null,
        exactSkuMatch:Boolean(proposed)&&proposed.sku===normalize(sourceRow.sku),
        note:values.note,requestId:values.requestId,
      }));
      const last=this.db.prepare(
        "SELECT id FROM audit WHERE action='inventory.owner_mapping_review' ORDER BY id DESC LIMIT 1"
      ).get();
      this.db.exec('COMMIT');
      return {
        kind:'local-unverified-owner-mapping-proposal',recorded:true,
        replayed:false,reviewId:last.id,auditOnly:true,
        mappingApproved:false,checkoutAuthorized:false,stockImportAuthorized:false,
      };
    }catch(error){
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
