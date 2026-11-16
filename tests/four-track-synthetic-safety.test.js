import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SyntheticStockCoordinator,runSyntheticStockScenarios,
} from '../server/synthetic-stock-safety.js';
import {
  SyntheticPaymentLedger,runSyntheticPaymentScenarios,
} from '../server/synthetic-payment-safety.js';

const ONE='a'.repeat(64),TWO='b'.repeat(64);

test('four-track build: synthetic shared last-unit stock owner never oversells variations',()=>{
  const result=runSyntheticStockScenarios();
  assert.equal(result.passed,true);
  assert.equal(result.scenarios.length,7);
  assert.ok(result.scenarios.every(x=>x.pass));
  assert.equal(result.realWooCommerceCalls,0);
  assert.equal(result.liveAtomicReservationVerified,false);
  assert.equal(result.checkoutAuthorized,false);
  const stock=new SyntheticStockCoordinator([
    {stockOwner:'parent:55',units:2},{stockOwner:'simple:2',units:0},
  ]);
  assert.deepEqual(stock.reserve({key:'one',stockOwner:'parent:55',
    variation:'UK-14',units:1,fingerprint:ONE}),{state:'reserved',replayed:false});
  assert.deepEqual(stock.reserve({key:'two',stockOwner:'parent:55',
    variation:'UK-16',units:1,fingerprint:TWO}),{state:'reserved',replayed:false});
  assert.equal(stock.reserve({key:'three',stockOwner:'parent:55',
    variation:'UK-18',units:1,fingerprint:ONE}).state,'insufficient');
  assert.equal(stock.reserve({key:'four',stockOwner:'simple:2',
    variation:'one',units:1,fingerprint:ONE}).state,'insufficient');
  assert.equal(stock.snapshot().stockOwnerPools[0].available,0);
  assert.throws(()=>stock.reserve({key:'one',stockOwner:'parent:55',
    variation:'UK-16',units:1,fingerprint:ONE}),e=>e.code==='SANDBOX_REPLAY_CONFLICT');
  assert.throws(()=>stock.reserve({key:'one',stockOwner:'parent:55',
    variation:'UK-14',units:1,fingerprint:TWO}),e=>e.code==='SANDBOX_REPLAY_CONFLICT');
  assert.equal(stock.cancel({key:'two',verifiedRemoteCancellation:true}).released,1);
  assert.equal(stock.cancel({key:'two',verifiedRemoteCancellation:true}).released,0);
  assert.equal(stock.snapshot().stockOwnerPools[0].available,1);
  assert.equal(stock.markPaid({key:'one',verified:true}).state,'paid');
  assert.equal(stock.markPaid({key:'two',verified:true}).state,'needs_review',
    'Paid callback for cancelled attempt cannot create fictitious stock hold.');
  assert.equal(stock.snapshot().stockOwnerPools[0].available,1);
  assert.equal(stock.verify(),true);
});
test('four-track build: uncertain hold and late payment never clear stock without authority',()=>{
  const stock=new SyntheticStockCoordinator([{stockOwner:'parent:1',units:1}]);
  stock.reserve({key:'hold',stockOwner:'parent:1',variation:'M',
    units:1,fingerprint:ONE});
  assert.equal(stock.cancel({key:'hold',verifiedRemoteCancellation:false}).released,0);
  assert.equal(stock.expire({key:'hold'}).released,0);
  assert.equal(stock.markPaid({key:'hold',verified:true}).state,'needs_review');
  assert.equal(stock.snapshot().stockOwnerPools[0].available,0);
  assert.throws(()=>stock.markPaid({key:'hold',verified:false}),
    e=>e.code==='SANDBOX_PAYMENT_UNVERIFIED');
  assert.equal(stock.cancel({key:'hold',verifiedRemoteCancellation:true}).released,0);
  assert.equal(stock.verify(),true);
});
test('four-track build: modeled payment callback, cash, refund and late-cancel guards',()=>{
  const result=runSyntheticPaymentScenarios();
  assert.equal(result.passed,true);
  assert.equal(result.scenarios.length,7);
  assert.ok(result.scenarios.every(x=>x.pass));
  assert.equal(result.realPaystackCalls,0);
  assert.equal(result.liveGatewayVerified,false);
  assert.equal(result.checkoutAuthorized,false);
  const ledger=new SyntheticPaymentLedger({orderKey:'order-8',amountCents:15300});
  assert.throws(()=>ledger.gateway({eventId:'paid-1',kind:'payment',
    orderKey:'order-8',amountCents:15300,signatureVerified:false}),
  e=>e.code==='SANDBOX_GATEWAY_UNTRUSTED');
  assert.throws(()=>ledger.gateway({eventId:'paid-2',kind:'payment',
    orderKey:'foreign',amountCents:15300,signatureVerified:true}),
  e=>e.code==='SANDBOX_GATEWAY_IDENTITY');
  assert.equal(ledger.gateway({eventId:'paid-3',kind:'payment',
    orderKey:'order-8',amountCents:15300,signatureVerified:true}).status,'paid');
  assert.equal(ledger.gateway({eventId:'refund-3',kind:'refund',
    amountCents:300,signatureVerified:true}).status,'partially_refunded');
  assert.equal(ledger.gateway({eventId:'refund-4',kind:'refund',
    amountCents:15000,signatureVerified:true}).status,'refunded');
  assert.equal(ledger.snapshot().refundedCents,15300);
  assert.equal(ledger.snapshot().paymentsAuthorized,false);
  const late=new SyntheticPaymentLedger();
  late.cancel({remoteCancellationVerified:true});
  assert.equal(late.gateway({eventId:'paid-late',kind:'payment',
    amountCents:10000,signatureVerified:true}).status,'needs_review');
  assert.equal(late.snapshot().checkoutAuthorized,false);
});
