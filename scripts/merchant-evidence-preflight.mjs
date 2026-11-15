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
  // Independently provisioned fingerprints only: never import existing
  // catalogue / reservation-bridge raw credentials into this new runtime.
  catalogueFingerprints: {
    consumerKeySha256: env.MANSU_EVIDENCE_CATALOGUE_KEY_SHA256 || '',
    consumerSecretSha256: env.MANSU_EVIDENCE_CATALOGUE_SECRET_SHA256 || '',
  },
  onlineBridgeFingerprint: env.MANSU_EVIDENCE_BRIDGE_PASSWORD_SHA256 || '',
});
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
// Exit success only means the OFFLINE preflight ran. The report's explicit
// live release gates are always false until independently reviewed elsewhere.
