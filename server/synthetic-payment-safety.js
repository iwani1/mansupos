import {createHash} from 'node:crypto';
import {AppError} from './errors.js';

// Fully synthetic POS/gateway lifecycle, no Paystack, WooCommerce, bank,
// in-store drawer or persistent cash transaction interfaces.
const key=/^[a-zA-Z0-9:_-]{2,72}$/;
const bad=(code,msg)=>{throw new AppError(msg,409,code);};
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

export class SyntheticPaymentLedger{
  constructor({orderKey='synthetic-order-1',amountCents=10000}={}){
    if(!key.test(orderKey)||!Number.isSafeInteger(amountCents)||
      amountCents<1||amountCents>100000000)
      bad('SANDBOX_INVALID_ORDER','Invalid synthetic payment fixture.');
    this.orderKey=orderKey;this.amountCents=amountCents;
    this.events=new Map();
    this.status='awaiting_payment';
    this.refundedCents=0;
    this.paidVia=null;
    this.needsReview=false;
  }
  gateway({eventId,orderKey=this.orderKey,kind,amountCents,
    signatureVerified=false}){
    if(!key.test(eventId||'')||!['payment','refund'].includes(kind)||
      !Number.isSafeInteger(amountCents)||amountCents<=0||
      orderKey!==this.orderKey)
      bad('SANDBOX_GATEWAY_IDENTITY','Gateway event identity or amount is invalid.');
    if(signatureVerified!==true)
      bad('SANDBOX_GATEWAY_UNTRUSTED','Gateway authenticity not proven in synthetic fixture.');
    const value={orderKey,kind,amountCents};
    if(this.events.has(eventId)){
      const prior=this.events.get(eventId);
      if(JSON.stringify(prior)!==JSON.stringify(value))
        bad('SANDBOX_CALLBACK_REPLAY_CONFLICT','Gateway event replay altered amount or type.');
      return {status:this.status,replayed:true,needsReview:this.needsReview};
    }
    this.events.set(eventId,value);
    if(kind==='payment'){
      if(amountCents!==this.amountCents||this.status==='cancelled'||
         this.status==='needs_review'||this.status==='refunded'||
         this.status==='partially_refunded'||this.paidVia&&this.paidVia!=='gateway'){
        this.needsReview=true;
        this.status='needs_review';
      }else if(this.status==='paid'){
        // Different gateway event ID is a separate potentially duplicate
        // financial event, not free confirmation of the same payment.
        this.needsReview=true;
        this.status='needs_review';
      }else{
        this.paidVia='gateway';this.status='paid';
      }
    }else{
      if(this.paidVia!=='gateway'||!['paid','partially_refunded'].includes(this.status)||
         this.refundedCents+amountCents>this.amountCents){
        this.needsReview=true;this.status='needs_review';
      }else{
        this.refundedCents+=amountCents;
        this.status=this.refundedCents===this.amountCents?'refunded':'partially_refunded';
      }
    }
    return {status:this.status,replayed:false,needsReview:this.needsReview};
  }
  cash({eventId,amountCents,confirmedShift=false,
    reservedOrderIdentityVerified=false}){
    if(!key.test(eventId||'')||!Number.isSafeInteger(amountCents)||
      amountCents<1||amountCents>100000000)
      bad('SANDBOX_CASH_EVENT_INVALID','Synthetic cash evidence is invalid.');
    if(confirmedShift!==true||reservedOrderIdentityVerified!==true||
      amountCents!==this.amountCents||this.paidVia==='gateway'||
      this.status!=='awaiting_payment')
      bad('SANDBOX_CASH_GUARD','Cash cannot be accepted without an original reserved order, exact amount and verified shift.');
    if(this.events.has(eventId))
      bad('SANDBOX_CASH_DUPLICATE','Cash event already recorded.');
    this.events.set(eventId,{kind:'cash',amountCents});
    this.paidVia='cash';this.status='paid';
    return {status:this.status,replayed:false};
  }
  cancel({remoteCancellationVerified=false}={}){
    if(this.status==='paid'||this.status==='partially_refunded'||
      this.status==='refunded'||this.status==='needs_review'){
      this.needsReview=true;return {status:this.status,releasedStock:0};
    }
    if(remoteCancellationVerified!==true){
      this.needsReview=true;this.status='needs_review';
      return {status:this.status,releasedStock:0};
    }
    this.status='cancelled';
    return {status:'cancelled',releasedStock:0};
  }
  snapshot(){
    return {
      syntheticOnly:true,orderKey:this.orderKey,status:this.status,
      paidVia:this.paidVia,refundedCents:this.refundedCents,
      originalAmountCents:this.amountCents,needsReview:this.needsReview,
      traceDigest:digest([...this.events]),
      realPaystackCalls:0,realWooCommerceCalls:0,
      paymentsAuthorized:false,liveGatewayVerified:false,
      stockImportAuthorized:false,checkoutAuthorized:false,
    };
  }
}
export function runSyntheticPaymentScenarios(){
  const scenarios=[];
  const actual=new SyntheticPaymentLedger();
  const first=actual.gateway({eventId:'gw-event-1',kind:'payment',
    amountCents:10000,signatureVerified:true});
  const same=actual.gateway({eventId:'gw-event-1',kind:'payment',
    amountCents:10000,signatureVerified:true});
  scenarios.push({id:'paid_and_exact_idempotent_callback',pass:
    first.status==='paid'&&same.replayed===true&&actual.snapshot().needsReview===false});
  let mismatch=false;
  try{actual.gateway({eventId:'gw-event-1',kind:'payment',
    amountCents:9999,signatureVerified:true});}
  catch(e){mismatch=e.code==='SANDBOX_CALLBACK_REPLAY_CONFLICT';}
  scenarios.push({id:'callback_replay_payload_mismatch',pass:mismatch});
  const partial=actual.gateway({eventId:'refund-1',kind:'refund',
    amountCents:2500,signatureVerified:true});
  const duplicate=actual.gateway({eventId:'refund-1',kind:'refund',
    amountCents:2500,signatureVerified:true});
  const rest=actual.gateway({eventId:'refund-2',kind:'refund',
    amountCents:7500,signatureVerified:true});
  scenarios.push({id:'refunds_exactly_once_with_amount_ceiling',pass:
    partial.status==='partially_refunded'&&duplicate.replayed===true&&
    rest.status==='refunded'&&actual.refundedCents===10000});
  const cancelled=new SyntheticPaymentLedger();
  cancelled.cancel({remoteCancellationVerified:true});
  const late=cancelled.gateway({eventId:'late-paid',kind:'payment',
    amountCents:10000,signatureVerified:true});
  scenarios.push({id:'late_payment_after_cancel_held_for_review',pass:
    late.needsReview===true&&late.status==='needs_review'});
  const untrusted=new SyntheticPaymentLedger();
  let denied=false;
  try{untrusted.gateway({eventId:'fake-paid',kind:'payment',
    amountCents:10000,signatureVerified:false});}
  catch(e){denied=e.code==='SANDBOX_GATEWAY_UNTRUSTED';}
  scenarios.push({id:'untrusted_webhook_never_marks_paid',pass:
    denied&&untrusted.snapshot().status==='awaiting_payment'});
  const noShift=new SyntheticPaymentLedger();
  let cashDenied=false;
  try{noShift.cash({eventId:'cash-paid',amountCents:10000,
    confirmedShift:false,reservedOrderIdentityVerified:true});}
  catch(e){cashDenied=e.code==='SANDBOX_CASH_GUARD';}
  scenarios.push({id:'cash_requires_shift_and_reserved_identity',pass:
    cashDenied&&noShift.snapshot().status==='awaiting_payment'});
  const pending=new SyntheticPaymentLedger();
  const uncertain=pending.cancel({remoteCancellationVerified:false});
  scenarios.push({id:'ambiguous_cancel_never_releases_stock',pass:
    uncertain.status==='needs_review'&&uncertain.releasedStock===0});
  const passed=scenarios.every(x=>x.pass);
  return {
    kind:'synthetic-payment-and-refund-safety-check',
    passed,scenarios,syntheticOnly:true,
    realPaystackCalls:0,realWooCommerceCalls:0,
    liveGatewayVerified:false,liveRefundsVerified:false,
    paymentsAuthorized:false,checkoutAuthorized:false,
    note:'This deterministic model does not verify actual webhook authenticity, gateway settlements, cash custody, installed Woo hooks, refunds, or recovery under deployment failures.',
  };
}
