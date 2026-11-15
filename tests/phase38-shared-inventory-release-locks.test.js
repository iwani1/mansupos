import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../server/config.js';
import { auditSharedWooStock } from '../server/phase2-stock-audit.js';

const file=relative=>fs.readFileSync(fileURLToPath(new URL(relative,import.meta.url)),'utf8');
const pilot={
  NODE_ENV:'production',POS_MODE:'live',POS_LIVE_READ_ONLY:'true',
  POS_ALLOW_LIVE_WRITES:'false',
  WOO_BASE_URL:'https://www.mansutrendzgh.com',
  POS_PUBLIC_ORIGIN:'https://pos.mansutrendzgh.com',
  WOO_CONSUMER_KEY:'ck_synthetic_catalogue_only',
  WOO_CONSUMER_SECRET:'cs_synthetic_catalogue_only',
};
test('Phase 3.8 pilot stays catalogue-read-only: no Woo writes, cash, wholesale or online bridge release',()=>{
  const c=readConfig(pilot);
  assert.equal(c.mode,'live');
  assert.equal(c.liveReadOnly,true);
  assert.equal(c.writesEnabled,false);
  assert.equal(c.wholesaleWritesEnabled,false);
  assert.equal(c.inStoreCashEnabled,false);
  assert.equal(c.onlineBridgeLiveEnabled,false);
  assert.equal(c.onlineBridgeEnabled,false);
  assert.equal(c.legacyLiveCheckoutBlocked,true);
  assert.throws(()=>readConfig({...pilot,POS_ALLOW_LIVE_WRITES:'true'}),
    /read-only live pilot cannot enable/);
  assert.throws(()=>readConfig({...pilot,POS_ONLINE_BRIDGE_LIVE_ENABLED:'true'}),
    /live Woo bridge requires/);
});
test('Woo/Paystack bridge late callback release flag remains hard false in the DRAFT source',()=>{
  const source=file('../woocommerce/mansu-online-bridge/mansu-online-bridge.php');
  assert.match(source,/'lateGatewayGuardVerified'\s*=>\s*false/);
  assert.doesNotMatch(source,/'lateGatewayGuardVerified'\s*=>\s*true/);
});
test('offline cutover remains outside POS HTTP routes, and phase-2 stock preview never authorizes checkout',()=>{
  const app=file('../server/app.js');
  const offline=file('../server/shared-woo-cutover-readiness.js');
  const cli=file('../scripts/assess-shared-woo-cutover.mjs');
  assert.equal(app.includes('assessSharedWooInventoryCutover'),false);
  assert.equal(app.includes('/api/stock-safety/cutover'),false);
  assert.equal(offline.includes('fetch('),false);
  assert.equal(cli.includes('fetch('),false);
  assert.equal(cli.includes('createOrder('),false);
  const at='2026-11-15T18:00:00.000Z';
  const preview=auditSharedWooStock({
    source:'woocommerce',fetchedAt:at,complete:true,stale:false,
    products:[{
      id:200,type:'variable',manageStock:true,stockSource:'product',stock:1,
      variations:[
        {id:201,stockSource:'parent',manageStock:true,purchasable:true,
          stockStatus:'instock',stock:1},
        {id:202,stockSource:'parent',manageStock:true,purchasable:true,
          stockStatus:'instock',stock:1},
      ],
    }],
  },Date.parse(at));
  assert.equal(preview.catalogue.managedStockPools,1);
  assert.equal(preview.catalogue.sharedParentOrVariationPools,1);
  assert.equal(preview.checkoutAuthorized,false);
  assert.equal(preview.sharedLastUnitGuardVerified,false);
});
