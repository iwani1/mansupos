import {createHash} from 'node:crypto';
import {AppError} from './errors.js';

// SYNTHETIC ONLY: a deterministic, in-memory concurrency / stock-owner model.
// This is NOT a WooCommerce reservation implementation, persistent ledger,
// real lock, payment gateway or authority to change any live quantities.
const allowed=/^[A-Za-z0-9:_-]{1,72}$/;
const fail=(code,message)=>{throw new AppError(message,409,code);};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

export class SyntheticStockCoordinator{
  constructor(pools){
    if(!Array.isArray(pools)||pools.length===0||pools.length>20)
      fail('SANDBOX_INVALID_POOLS','Synthetic pools must be explicitly supplied.');
    this.pools=new Map();this.attempts=new Map();this.events=[];
    for(const x of pools){
      if(!allowed.test(x?.stockOwner||'')||!Number.isSafeInteger(x.units)||
        x.units<0||x.units>1000000||this.pools.has(x.stockOwner))
        fail('SANDBOX_INVALID_POOL','Duplicate or invalid synthetic stock owner.');
      this.pools.set(x.stockOwner,{initial:x.units,available:x.units});
    }
  }
  reserve({key,stockOwner,variation,units,fingerprint}){
    if(!allowed.test(key||'')||!allowed.test(stockOwner||'')||
      !allowed.test(variation||'')||
      !Number.isSafeInteger(units)||units<1||units>10000||
      !/^[a-f0-9]{64}$/.test(fingerprint||''))
      fail('SANDBOX_INVALID_ATTEMPT','Invalid synthetic reservation attempt.');
    const previous=this.attempts.get(key);
    const parameters={stockOwner,variation,units,fingerprint};
    if(previous){
      if(JSON.stringify(previous.parameters)!==JSON.stringify(parameters))
        fail('SANDBOX_REPLAY_CONFLICT','Reservation key reused with different parameters.');
      return {state:previous.state,replayed:true};
    }
    const pool=this.pools.get(stockOwner);
    if(!pool)fail('SANDBOX_STOCK_OWNER_UNKNOWN','Stock owner is not in the synthetic fixture.');
    const state=pool.available>=units?'reserved':'insufficient';
    if(state==='reserved')pool.available-=units;
    this.attempts.set(key,{key,parameters,state});
    this.events.push({kind:'reservation_attempt',key,state});
    this.verify();
    return {state,replayed:false};
  }
  markPaid({key,verified,orderIdentityMatched=true}){
    if(verified!==true||orderIdentityMatched!==true)
      fail('SANDBOX_PAYMENT_UNVERIFIED','Payment requires matching order and verified synthetic callback.');
    const attempt=this.attempts.get(key);
    if(!attempt)fail('SANDBOX_PAYMENT_UNKNOWN','Missing original attempt.');
    if(attempt.state==='paid')return {state:'paid',replayed:true};
    if(attempt.state!=='reserved'){
      // A cancelled or rejected attempt owns NO held units. Mutating it to a
      // stock-consuming state would fabricate a hold and violate conservation.
      if(attempt.state==='uncertain_hold')attempt.state='needs_review';
      this.events.push({kind:'late_or_unexpected_payment',key,state:'needs_review'});
      this.verify();
      return {state:'needs_review',replayed:false};
    }
    attempt.state='paid';
    this.events.push({kind:'verified_payment',key,state:'paid'});
    this.verify();
    return {state:'paid',replayed:false};
  }
  cancel({key,verifiedRemoteCancellation}){
    const attempt=this.attempts.get(key);
    if(!attempt)fail('SANDBOX_CANCEL_UNKNOWN','No original attempt.');
    if(verifiedRemoteCancellation!==true){
      if(attempt.state==='reserved')attempt.state='uncertain_hold';
      this.events.push({kind:'unverified_cancel',key,state:attempt.state});
      this.verify();
      return {state:attempt.state,released:0};
    }
    if(attempt.state==='cancelled')return {state:'cancelled',released:0,replayed:true};
    if(attempt.state!=='reserved'){
      this.events.push({kind:'cancel_requires_review',key,state:attempt.state});
      return {state:attempt.state,released:0};
    }
    const pool=this.pools.get(attempt.parameters.stockOwner);
    pool.available+=attempt.parameters.units;
    attempt.state='cancelled';
    this.events.push({kind:'verified_cancellation',key,state:'cancelled'});
    this.verify();
    return {state:'cancelled',released:attempt.parameters.units};
  }
  expire({key}){
    const attempt=this.attempts.get(key);
    if(!attempt)fail('SANDBOX_EXPIRE_UNKNOWN','No attempt for this expiry.');
    if(attempt.state==='reserved')attempt.state='uncertain_hold';
    this.events.push({kind:'expiry_no_auto_release',key,state:attempt.state});
    this.verify();
    return {state:attempt.state,released:0};
  }
  verify(){
    for(const [owner,pool] of this.pools){
      const consumed=[...this.attempts.values()].filter(x=>
        x.parameters.stockOwner===owner&&
        ['reserved','uncertain_hold','paid','needs_review'].includes(x.state))
        .reduce((n,x)=>n+x.parameters.units,0);
      if(!Number.isSafeInteger(pool.available)||pool.available<0||
        pool.available+consumed!==pool.initial)
        fail('SANDBOX_STOCK_CONSERVATION_FAILURE','Synthetic stock-pool conservation failed.');
    }
    return true;
  }
  snapshot(){
    this.verify();
    return {
      syntheticOnly:true,
      stockOwnerPools:[...this.pools].map(([stockOwner,p])=>({stockOwner,...p})),
      attempts:[...this.attempts.values()].map(x=>({
        key:x.key,stockOwner:x.parameters.stockOwner,
        variation:x.parameters.variation,units:x.parameters.units,state:x.state,
      })),
      traceDigest:digest(this.events),
      realWooCommerceCalls:0,actualStockWrites:0,
      liveReservationsVerified:false,stockImportAuthorized:false,checkoutAuthorized:false,
    };
  }
}
const F='1'.repeat(64),G='2'.repeat(64);
export function runSyntheticStockScenarios(){
  const tests=[];
  const unit=new SyntheticStockCoordinator([{stockOwner:'parent:11',units:1}]);
  const a=unit.reserve({key:'attempt-A',stockOwner:'parent:11',variation:'size-S',units:1,fingerprint:F});
  const b=unit.reserve({key:'attempt-B',stockOwner:'parent:11',variation:'size-M',units:1,fingerprint:G});
  tests.push({id:'last_unit_shared_parent',pass:a.state==='reserved'&&b.state==='insufficient'&&unit.verify()});
  const replay=unit.reserve({key:'attempt-A',stockOwner:'parent:11',variation:'size-S',units:1,fingerprint:F});
  tests.push({id:'idempotent_reservation_retry',pass:replay.replayed===true&&unit.snapshot().stockOwnerPools[0].available===0});
  let conflict=false;
  try{unit.reserve({key:'attempt-A',stockOwner:'parent:11',variation:'size-M',units:1,fingerprint:F});}
  catch(e){conflict=e.code==='SANDBOX_REPLAY_CONFLICT';}
  tests.push({id:'changed_retry_rejected',pass:conflict});
  const timeout=unit.expire({key:'attempt-A'});
  const uncertain=unit.cancel({key:'attempt-A',verifiedRemoteCancellation:false});
  tests.push({id:'timeout_hold_not_released',pass:timeout.released===0&&uncertain.released===0&&unit.snapshot().stockOwnerPools[0].available===0});
  const late=unit.markPaid({key:'attempt-A',verified:true});
  tests.push({id:'late_payment_on_uncertain_hold_reviewed',pass:late.state==='needs_review'&&unit.snapshot().stockOwnerPools[0].available===0});
  const fresh=new SyntheticStockCoordinator([{stockOwner:'variation:7',units:2}]);
  fresh.reserve({key:'reserve',stockOwner:'variation:7',variation:'blue-L',units:2,fingerprint:F});
  const cancel=fresh.cancel({key:'reserve',verifiedRemoteCancellation:true});
  const duplicate=fresh.cancel({key:'reserve',verifiedRemoteCancellation:true});
  tests.push({id:'verified_cancel_releases_once',pass:cancel.released===2&&duplicate.released===0&&fresh.snapshot().stockOwnerPools[0].available===2});
  const noDouble=new SyntheticStockCoordinator([{stockOwner:'simple:1',units:1}]);
  noDouble.reserve({key:'paid-order',stockOwner:'simple:1',variation:'none',units:1,fingerprint:F});
  const paid=noDouble.markPaid({key:'paid-order',verified:true});
  const after=noDouble.cancel({key:'paid-order',verifiedRemoteCancellation:true});
  tests.push({id:'paid_order_not_restocked_by_cancel',pass:paid.state==='paid'&&after.released===0&&noDouble.snapshot().stockOwnerPools[0].available===0});
  const ok=tests.every(t=>t.pass);
  return {
    kind:'synthetic-shared-stock-safety-check',
    passed:ok,scenarios:tests,
    simulatedStockOwnerPools:3,
    syntheticOnly:true,realWooCommerceCalls:0,actualStockWrites:0,
    liveAtomicReservationVerified:false,stockImportAuthorized:false,
    checkoutAuthorized:false,
    note:'In-process model only. It does not verify cross-worker locks, Woo installed plugins, production stock owners, order lifecycle or real stock reconciliation.',
  };
}
