import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../server/errors.js';
import { deviceIdSchema, syncEventSchema } from '../contracts.js';

// Reserved .invalid address is only a local ledger identity. This build has
// no HTTP transport; its origin cannot resolve to a shop or trading service.
export const TRIAL_ORIGIN = 'https://offline-practice.invalid';

// Every identity and SKU here is fabricated. The value of `source` in the
// fixture satisfies the real desktop bootstrap contract; it is NOT evidence
// that WooCommerce was contacted or that any public stock was held.
export const TRIAL_USERNAME = 'practice';
export const TRIAL_PASSWORD = 'practice-only-no-real-credentials';
const user = { id:'21cc4dd1-1932-4f3e-972c-1488627a1ecb', username:TRIAL_USERNAME,
  name:'Practice operator', role:'owner', mustChangePassword:false };
const deviceSecret = 'a'.repeat(64); // Public dummy only; never use it for live till provisioning.
const quantities = { '991001:0':2, '991002:0':2 };
const base = { category:'Practice samples', categories:['Practice samples'], image:'',
  manageStock:true, purchasable:true, backorders:'no', backordersAllowed:false,
  stockStatus:'instock', soldIndividually:false };

export function sampleCatalog() {
  return { source:'woocommerce', complete:true, stale:false, fetchedAt:new Date().toISOString(), products:[
    { ...base, id:991001, type:'simple', name:'SAMPLE scarf — not for sale', sku:'QA-SCARF-01',
      barcode:'QA-SCARF-01', price:2500, stockSource:'product', stock:2, variations:[] },
    { ...base, id:991002, type:'variable', name:'SAMPLE tee — not for sale', sku:'QA-TEE',
      barcode:'QA-TEE', price:3500, stockSource:'parent', stock:2, variations:[
        { ...base, id:991003, label:'Small', sku:'QA-TEE-S', barcode:'QA-TEE-S', price:3500, stockSource:'parent', stock:2,
          attributes:[{name:'Size',option:'Small'}] },
        { ...base, id:991004, label:'Large', sku:'QA-TEE-L', barcode:'QA-TEE-L', price:3500, stockSource:'parent', stock:2,
          attributes:[{name:'Size',option:'Large'}] },
      ] },
  ] };
}
const fingerprint = event => createHash('sha256').update(JSON.stringify(event)).digest('hex');

// This is NOT a network client. It never uses fetch/http, never accepts a
// Woo credential and does not create an order anywhere. Its only sync output
// is a deterministic, simulated receipt acknowledgement for the same ID.
export class TrialRemote {
  constructor() {
    this.online = false; this.store = null;
    this.expectedService = Object.freeze({ mode:'practice', storeUrl:TRIAL_ORIGIN });
  }
  validateOrigin(origin) {
    if (origin !== TRIAL_ORIGIN) throw new AppError('Only the built-in offline practice identity is permitted.', 403, 'TRIAL_ONLY');
    return TRIAL_ORIGIN;
  }
  setConnected(value) { this.online = value === true; return this.online; }
  bootstrap(deviceId) {
    const expiry = new Date(Date.now() + 12 * 3600000).toISOString();
    const existing = this.store?.db.prepare('SELECT * FROM allocations ORDER BY stock_key').all() || [];
    const grants = Object.entries(quantities).map(([key, initial]) => {
      const prior = existing.find(row => row.stock_key === key);
      return { stockKey:key, productId:Number(key.split(':')[0]), variationId:0,
        remaining:prior ? prior.remaining : initial, revision:prior ? prior.revision : 1, expiresAt:expiry };
    });
    return { deviceId, canSell:grants.some(g => g.remaining > 0), canWholesale:false,
      leaseExpiresAt:expiry, catalog:sampleCatalog(), wholesalePrices:[], grants };
  }
  async request(origin, token, resource, method, body) {
    this.validateOrigin(origin);
    if (resource === '/auth/login' && method === 'POST' && !token) {
      if (body?.username !== TRIAL_USERNAME || body?.password !== TRIAL_PASSWORD) {
        throw new AppError('Only built-in practice credentials are accepted.', 403, 'TRIAL_ONLY');
      }
      return { user, token:'LOCAL-PRACTICE-NO-NETWORK', config:this.expectedService };
    }
    if (token !== 'LOCAL-PRACTICE-NO-NETWORK') throw new AppError('Practice accepts only its built-in fake identity.', 403, 'TRIAL_ONLY');
    if (resource === '/desktop/enroll' && method === 'POST') return { deviceId:deviceIdSchema.parse(body?.deviceId), enrolled:true, deviceSecret };
    if (resource.startsWith('/desktop/bootstrap?deviceId=') && method === 'GET') {
      const id = deviceIdSchema.parse(resource.split('=')[1]);
      return this.bootstrap(id);
    }
    if (resource === '/desktop/sync' && method === 'POST') {
      if (!this.online) throw new AppError('Practice sync is simulated OFFLINE. Keep this event pending, restart if desired, then switch the fake connection on.', 503, 'TRIAL_OFFLINE');
      const event = syncEventSchema.parse(body?.event);
      const recorded = this.store?.db.prepare("SELECT fingerprint,kind FROM queue WHERE id=? AND state<>'acked'").get(event.id);
      if (event.kind !== 'sale' || event.saleType !== 'retail' || event.paymentMethod !== 'cash' ||
          event.items.some(item => !Object.hasOwn(quantities, item.stockKey) || ![991001,991002].includes(item.productId)) ||
          event.deviceId !== this.store?.setting('deviceId') || recorded?.kind !== 'sale' ||
          recorded.fingerprint !== fingerprint(event)) {
        throw new AppError('Only a recorded sample event from this practice till can be acknowledged.', 409, 'TRIAL_ONLY');
      }
      const expected = createHmac('sha256', deviceSecret).update(JSON.stringify(event)).digest();
      const received = Buffer.from(String(body?.signature || ''), 'hex');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        throw new AppError('Practice event signature did not match the local ledger.', 403, 'TRIAL_ONLY');
      }
      return { id:event.id, fingerprint:fingerprint(event), status:'acked' }; // NO Woo order ID exists.
    }
    throw new AppError('Live service calls are not available in this practice app.', 403, 'TRIAL_ONLY');
  }
}
