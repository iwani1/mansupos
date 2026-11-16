import {createHash} from 'node:crypto';
import {AppError} from './errors.js';
import {runSyntheticStockScenarios} from './synthetic-stock-safety.js';
import {runSyntheticPaymentScenarios} from './synthetic-payment-safety.js';

// A read-only, fail-closed four-track build and acceptance report.
// PASSING A SYNTHETIC SIMULATION DOES NOT VERIFY ANY PRODUCTION SITE.
// The external proofs are not accepted or stored here.
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SHA=/^[a-f0-9]{64}$/;
const globalHolds=Object.freeze({
  productionReady:false,acceptanceCertificateIssued:false,
  independentPhysicalProofVerified:false,
  reviewerIdentityAndIndependenceVerified:false,
  originalPhysicalCountVerified:false,
  variationMappingApproved:false,
  installedWooReservationsVerified:false,
  realPaystackCallbacksVerified:false,
  realRefundSettlementVerified:false,
  offHostBackupRestoreVerified:false,
  disasterRecoveryDrillVerified:false,
  staffTrainingSignedOff:false,
  securityReviewSignedOff:false,
  ciFinalCommitVerified:false,
  authorizedLiveDeployment:false,
  stockImportAuthorized:false,
  checkoutAuthorized:false,
  paymentsAuthorized:false,
});
const requirements=[
  {id:'signed_independent_inventory_recount',track:'physical',
    reason:'Independent witness identity, signature, original sheets, quantity reconciliation and custody are NOT established'},
  {id:'formal_variation_crosswalk',track:'physical',
    reason:'Owner-approved style, colour, size and product/variation identity crosswalk is missing'},
  {id:'installed_woo_atomic_reservation',track:'sync',
    reason:'Need on-site multi-process, Woo hook and atomic last-unit stock-owner testing'},
  {id:'website_pos_conflict_and_recovery',track:'sync',
    reason:'Need simultaneous POS/web order, cancellation, late callback and restart/recovery validation'},
  {id:'gateway_signature_and_callback_replay',track:'payment',
    reason:'Need Paystack/installed-site verification, signature, settlement, duplicate and out-of-order callback testing'},
  {id:'cash_shift_and_refund_settlement',track:'payment',
    reason:'Need witnessed cash custody, shift boundaries, refund payouts and bank/payment reconciliation'},
  {id:'offhost_backup_and_restoration',track:'release',
    reason:'Need independently witnessed backup integrity, off-host restore and rollback drill'},
  {id:'final_ci_security_staff_signoff',track:'release',
    reason:'Need exact-commit green CI, security assessment, staff training and distinct Owner release acceptance'},
];
export class FullLaunchReadiness{
  constructor(auditHandoff){this.auditHandoff=auditHandoff;}
  build(user,physical,website,clock=Date.now()){
    if(user?.role!=='owner')
      throw new AppError('Only the Owner can inspect the full pre-launch hold report.',403,
        'FULL_LAUNCH_OWNER_ONLY');
    const audit=this.auditHandoff.build(user,physical,website,clock);
    if(audit?.kind!=='owner-inventory-audit-handoff'||
      audit.auditOnly!==true||audit.releaseReady!==false||
      audit.stockImportAuthorized!==false||
      audit.checkoutAuthorized!==false||
      audit.content?.stockImportAuthorized!==false||
      !SHA.test(audit.sha256||'')||
      !Array.isArray(audit.content?.items)||
      !Array.isArray(audit.content?.globalRequirements)||
      audit.content.summary?.acceptedRows!==0)
      throw new AppError('Independent inventory audit evidence could not be safely assembled.',
        409,'FULL_LAUNCH_AUDIT_INCOMPLETE');
    const stock=runSyntheticStockScenarios();
    const payment=runSyntheticPaymentScenarios();
    const stages=[
      {
        id:'physical_inventory_acceptance',
        label:'Independent inventory evidence and acceptance',
        developmentArtifact:'Evidence handoff, readiness matrix and provisional case records',
        syntheticCheck:'not_applicable',
        externallyVerified:false,productionEnabled:false,
      },
      {
        id:'store_website_stock_synchronization',
        label:'Store and WooCommerce stock reservation safety',
        developmentArtifact:'Synthetic shared stock-owner and last-unit concurrency fixture',
        syntheticCheck:stock.passed?'synthetic_pass':'synthetic_fail',
        externallyVerified:false,productionEnabled:false,
      },
      {
        id:'checkout_payments_refunds',
        label:'Checkout, Paystack, cash and refunds',
        developmentArtifact:'Synthetic callback/cash/refund state-machine fixture',
        syntheticCheck:payment.passed?'synthetic_pass':'synthetic_fail',
        externallyVerified:false,productionEnabled:false,
      },
      {
        id:'security_backup_training_release',
        label:'Security, rollback, recovery, training and controlled deployment',
        developmentArtifact:'Fail-closed production acceptance and deployment checklist',
        syntheticCheck:'not_applicable',
        externallyVerified:false,productionEnabled:false,
      },
    ];
    const evidence={
      sourceHash:audit.content.sourceHash,
      independentAuditManifestSha256:audit.sha256,
      historicalSourceRows:audit.content.summary.historicalRows,
      unresolvedPhysicalCountRows:audit.content.summary.disputedRows,
      sourceRowsAccepted:0,
      syntheticStockTestCount:stock.scenarios.length,
      syntheticStockChecksPassed:stock.scenarios.filter(x=>x.pass).length,
      syntheticPaymentTestCount:payment.scenarios.length,
      syntheticPaymentChecksPassed:payment.scenarios.filter(x=>x.pass).length,
      syntheticWooOrderWrites:stock.realWooCommerceCalls+payment.realWooCommerceCalls,
      syntheticGatewayCalls:payment.realPaystackCalls,
    };
    const content={
      format:'mansupos-four-track-build-readiness-v1',
      stages,requirements:requirements.map(x=>({
        ...x,verified:false,acceptanceBlocked:true,
      })),
      evidence,
      stockSimulation:stock,
      paymentSimulation:payment,
      ...globalHolds,
    };
    return {
      kind:'owner-four-track-launch-readiness',
      evidenceRef:hash(content),content,
      auditOnly:true,releaseBlocked:true,
      ...globalHolds,
      notice:'The remaining development safeguards can be built and tested against synthetic cases, but external real-world stock verification, installed Woo/Paystack testing, backup restoration and release authorization have NOT occurred. Do not deploy this report as a production authorization.',
    };
  }
}
