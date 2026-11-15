// Local browser-only worksheet for owner investigation; never a stock import.
const cell=value=>{
  // eslint-disable-next-line no-control-regex -- Export must strip CSV control bytes.
  let text=String(value??'').replace(/[\u0000-\u001f\u007f]/g,'');
  if(/^\s*[=+@-]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
};
export function inventoryDossierCsv(report){
  if(report?.kind!=='read-only-inventory-evidence-dossier'||
     report.auditOnly!==true||report.checkoutAuthorized!==false||
     report.stockImportAuthorized!==false||report.mappingApproved!==false||
     report.ownerApproved!==false||!report.evidenceVerified||
     !/^[a-f0-9]{64}$/.test(report.dossierRef||'')||
     !Array.isArray(report.items)||report.items.length>50)
    throw new Error('Inventory dossier evidence is not verified for private export.');
  const header=[
    'NOT APPROVED - investigation only','Dossier SHA256','Source row',
    'Historical SKU','Initial identity classification','Next manual review',
    'Owner mapping decision','Proposed Woo product ID','Proposed Woo variation ID',
    'Count claim state','Unresolved evidence issues',
  ];
  const data=report.items.map(item=>{
    if(!Number.isSafeInteger(item.reportRow)||item.reportRow<1||
       typeof item.sku!=='string'||item.sku.length>64||
       typeof item.nextReview!=='string'||
       !Array.isArray(item.blockers)||item.blockers.length>20||
       item.mappingApproved!==false||item.stockImportAuthorized!==false)
      throw new Error('Invalid dossier row. Nothing exported.');
    return [
      'NOT APPROVED',report.dossierRef,item.reportRow,item.sku,
      item.mappingClassification,item.nextReview,item.ownerMappingDecision||'',
      item.proposedWooProductId||'',item.proposedWooVariationId||'',
      item.countStage,item.blockers.join(';'),
    ];
  });
  return [header,...data].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
