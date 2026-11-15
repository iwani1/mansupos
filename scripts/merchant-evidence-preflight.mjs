#!/usr/bin/env node
/**
 * Explicit, OFFLINE preflight for a FUTURE dedicated financial-read service.
 *
 * Never schedules work, calls the network, loads the POS app or accesses the
 * merchant's website. A successful FORMAT review is NOT live authorization.
 * Secrets are consumed only from the invoking process environment and are
 * never printed, saved or sent.
 */
import { assessMerchantEvidenceProvisioning } from '../server/merchant-evidence-boundary.js';

const env = process.env;
const result = assessMerchantEvidenceProvisioning({
  env,
  catalogueCredentials: {
    consumerKey: env.WOO_CONSUMER_KEY || '',
    consumerSecret: env.WOO_CONSUMER_SECRET || '',
  },
  onlineBridgeCredentials: {
    appPassword: env.POS_ONLINE_BRIDGE_APP_PASSWORD || '',
  },
});
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
// Exit success only means the OFFLINE preflight ran. The report's explicit
// live release gates are always false until independently reviewed elsewhere.
