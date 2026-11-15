// Generates a local, *blank* review worksheet for the visible page only.
// No stock balance, name, price, customer record, payment, Woo write or staff
// approval is embedded. Browser downloads should be protected as private files.
const csvCell = value => {
  // eslint-disable-next-line no-control-regex -- CSV export intentionally strips control bytes.
  let safe=String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,'');
  if (/^\s*[=+@-]/u.test(safe)) safe="'"+safe;
  return '"'+safe.replaceAll('"','""')+'"';
};

export function blankPhysicalRecountCsv(report){
  if(report?.kind!=='read-only-physical-recount-plan'||
     report.checkoutAuthorized!==false||report.stockImportAuthorized!==false||
     !/^[a-f0-9]{64}$/.test(report.snapshotRef||'')||
     !/^[a-f0-9]{64}$/.test(report.physicalManifestSha256||'')||
     !Array.isArray(report.tasks)||report.tasks.length>50||
     !Number.isSafeInteger(report.page)||report.page<1){
    throw new Error('Stock-count worksheet source is not verified.');
  }
  const header=[
    'Historical source SHA256','Review snapshot SHA256',
    'Historical source row','Historical SKU','Issue priority',
    'Mapping classification','Suggested action',
    'Count 1 (blank)','Counter 1 (blank)','Witness 1 (blank)',
    'Independent count 2 (blank)','Counter 2 (blank)',
    'Reviewer observation (blank)','Owner decision (blank)',
  ];
  const rows=report.tasks.map(row=>{
    if(!Number.isSafeInteger(row.reportRow)||row.reportRow<1||
       typeof row.sku!=='string'||row.sku.length>64||
       !['P0','P1','P2'].includes(row.priority)||
       !/^[a-z_]+$/.test(row.mappingStatus||'')||
       !/^[a-z_]+$/.test(row.nextAction||'')||
       row.physicalCountEvidenceRecorded!==false||
       row.independentRecountEvidenceRecorded!==false||
       row.stockImportAuthorized!==false){
      throw new Error('Stock-count worksheet row is not safe.');
    }
    return [
      report.physicalManifestSha256,report.snapshotRef,row.reportRow,
      row.sku,row.priority,row.mappingStatus,row.nextAction,
      '','','','','','','',
    ];
  });
  return [header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
