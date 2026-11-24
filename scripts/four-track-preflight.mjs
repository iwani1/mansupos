#!/usr/bin/env node
// Four-track pre-release guard. No network, Woo, Paystack, Contabo or
// customer data access. A PASS proves ONLY deterministic fixture behavior.
import {runSyntheticStockScenarios} from '../server/synthetic-stock-safety.js';
import {runSyntheticPaymentScenarios} from '../server/synthetic-payment-safety.js';
import {readConfig} from '../server/config.js';

const stock=runSyntheticStockScenarios();
const payment=runSyntheticPaymentScenarios();
const env={
  NODE_ENV:'production',POS_MODE:'live',
  POS_LIVE_READ_ONLY:'true',POS_ALLOW_LIVE_WRITES:'false',
  POS_ONLINE_BRIDGE_LIVE_ENABLED:'false',
  POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com',
  WOO_BASE_URL:'https://mansutrendzgh.com',
};
let locked;
try{
  const config=readConfig(env);
  locked=config.liveReadOnly===true&&config.writesEnabled===false&&
    config.onlineBridgeEnabled===false&&config.inStoreCashEnabled===false&&
    config.desktopEnabled===false&&config.wholesaleWritesEnabled===false;
  try{
    readConfig({...env,POS_ALLOW_LIVE_WRITES:'true'});
    locked=false;
  }catch{/* expected: read-only pilot rejects writes */}
}catch{locked=false;}
const syntheticPassed=stock.passed===true&&payment.passed===true&&locked;
const hold={
  kind:'four-track-synthetic-preflight',
  syntheticChecksPassed:syntheticPassed,
  stockScenarios:stock.scenarios.length,
  paymentScenarios:payment.scenarios.length,
  readOnlyConfigurationLocked:locked,
  realExternalStockWitnessVerified:false,
  liveWooConcurrencyVerified:false,
  livePaystackSettlementVerified:false,
  backupRestoreVerified:false,
  finalLiveDeploymentAuthorized:false,
  productionReady:false,
};
process.stdout.write(JSON.stringify(hold,null,2)+'\n');
if(!syntheticPassed){
  process.stderr.write('Synthetic preflight failed. Never deploy.\n');
  process.exitCode=1;
}else if(process.argv.includes('--require-production-ready')){
  process.stderr.write('LIVE RELEASE BLOCKED: external physical verification, installed Woo/Paystack testing, backup restoration and explicit Owner signoff remain missing.\n');
  process.exitCode=2;
}
