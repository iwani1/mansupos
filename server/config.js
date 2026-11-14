import 'dotenv/config';
import path from 'node:path';

export const APP_VERSION = '1.2.3';
const PRODUCTION_HOSTS = ['mansutrendzgh.com', 'www.mansutrendzgh.com'];

function httpsOrigin(value, label) {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`${label} must be an HTTPS origin without credentials, path, query, or fragment.`);
  }
  return url.origin;
}

export function readConfig(env = process.env) {
  const mode = env.POS_MODE || 'demo';
  if (!['demo', 'staging', 'live'].includes(mode)) throw new Error('POS_MODE must be demo, staging, or live.');
  const storeUrl = httpsOrigin(env.WOO_BASE_URL || 'https://www.mansutrendzgh.com', 'WOO_BASE_URL');
  const url = new URL(storeUrl);
  const productionHost = PRODUCTION_HOSTS.includes(url.hostname);
  if (mode === 'staging' && productionHost) throw new Error('Staging must use a separate staging URL, not the production store.');
  if (mode === 'live' && !productionHost) throw new Error('Live mode is restricted to the approved MansutRENDZGH store hostname.');
  // A live catalogue pilot may read the real store, but can never create or
  // update WooCommerce orders, even if an approval flag is later copied in.
  if (env.POS_LIVE_READ_ONLY && !['true', 'false'].includes(env.POS_LIVE_READ_ONLY)) throw new Error('POS_LIVE_READ_ONLY must be true or false.');
  const liveReadOnly = env.POS_LIVE_READ_ONLY === 'true';
  if (liveReadOnly && mode !== 'live') throw new Error('POS_LIVE_READ_ONLY is only valid with POS_MODE=live.');
  if (liveReadOnly && env.POS_ALLOW_LIVE_WRITES === 'true') throw new Error('A read-only live pilot cannot enable POS_ALLOW_LIVE_WRITES.');

  const production = env.NODE_ENV === 'production';
  const publicOrigin = httpsOrigin(env.POS_PUBLIC_ORIGIN || '', 'POS_PUBLIC_ORIGIN');
  if (production && mode !== 'demo' && !publicOrigin) {
    throw new Error('Production staging/live requires POS_PUBLIC_ORIGIN, for example https://pos.your-domain.example.');
  }
  const configured = Boolean(env.WOO_CONSUMER_KEY && env.WOO_CONSUMER_SECRET);
  const approvalReference = (env.POS_OWNER_APPROVAL_REFERENCE || '').trim();
  const writesEnabled = mode === 'staging'
    ? configured && env.POS_STAGING_APPROVED === 'true'
    : mode === 'live' && !liveReadOnly && configured && env.POS_ALLOW_LIVE_WRITES === 'true' && approvalReference.length >= 8;
  // Wholesale is a separate, explicitly approved write path. Staging approval
  // is only for staging; a no-staging live rollout must not pretend it passed
  // staging tests. Require a distinct reference to documented live acceptance.
  const liveWholesaleAcceptance = (env.POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE || '').trim();
  if (mode === 'live' && env.POS_LIVE_WHOLESALE_APPROVED === 'true' && liveWholesaleAcceptance.length < 8) {
    throw new Error('Live wholesale approval also requires a documented POS_LIVE_WHOLESALE_ACCEPTANCE_REFERENCE.');
  }
  const wholesaleWritesEnabled = mode === 'demo' || (writesEnabled && (mode === 'staging'
    ? env.POS_STAGING_WHOLESALE_APPROVED === 'true'
    : env.POS_LIVE_WHOLESALE_APPROVED === 'true' && liveWholesaleAcceptance.length >= 8));
  // A separate, initially OFF reservation rollout. This is not implied by
  // ordinary Woo POS write approval and is never valid on the catalogue pilot.
  const desktopRequested = env.POS_DESKTOP_RESERVATION_APPROVED === 'true';
  const desktopSetupRequested = env.POS_DESKTOP_SETUP_APPROVED === 'true';
  for (const key of ['POS_DESKTOP_SETUP_APPROVED','POS_DESKTOP_RESERVATION_APPROVED']) {
    if (env[key] && !['true', 'false'].includes(env[key])) throw new Error(`${key} must be true or false.`);
  }
  const desktopSetupReference = (env.POS_DESKTOP_SETUP_REFERENCE || '').trim();
  const desktopDeviceMasterSecret = env.POS_DESKTOP_DEVICE_MASTER_SECRET || '';
  if (desktopSetupRequested && (mode !== 'live' || liveReadOnly || !writesEnabled || !env.POS_DESKTOP_WP_APP_USER ||
      !env.POS_DESKTOP_WP_APP_PASSWORD || desktopDeviceMasterSecret.length < 32 ||
      desktopSetupReference.length < 8 || desktopSetupReference === approvalReference)) {
    throw new Error('Offline setup requires a separate live trading service, distinct setup reference, dedicated WordPress Application Password, and a 32+ character device signing secret; never the read-only pilot.');
  }
  const desktopSetupEnabled = desktopSetupRequested && mode === 'live' && !liveReadOnly && writesEnabled;
  const desktopAcceptance = (env.POS_DESKTOP_ACCEPTANCE_REFERENCE || '').trim();
  if (desktopRequested && (!desktopSetupEnabled || desktopAcceptance.length < 8 || desktopAcceptance === approvalReference ||
      desktopAcceptance === desktopSetupReference || desktopAcceptance === liveWholesaleAcceptance)) {
    throw new Error('Offline selling requires a distinct documented live website-checkout acceptance AFTER reservation setup and witnessed last-unit tests.');
  }
  const desktopEnabled = desktopRequested && desktopSetupEnabled;
  // This is a legacy local-stock path. The client's new shared-Woo plan must
  // never run it outside isolated tests: a local deduction would leave website
  // stock unchanged. Keep fixture coverage for historical ledger safety.
  if (env.POS_INSTORE_CASH_APPROVED && !['true', 'false'].includes(env.POS_INSTORE_CASH_APPROVED)) {
    throw new Error('POS_INSTORE_CASH_APPROVED must be true or false.');
  }
  const inStoreRequested = env.POS_INSTORE_CASH_APPROVED === 'true';
  const inStoreAcceptanceReference = (env.POS_INSTORE_ACCEPTANCE_REFERENCE || '').trim();
  const inStoreSourceHash = (env.POS_INSTORE_SOURCE_SHA256 || '').trim().toLowerCase();
  if (inStoreRequested && (mode !== 'live' || liveReadOnly || inStoreAcceptanceReference.length < 8 ||
      inStoreAcceptanceReference === approvalReference || !/^[a-f0-9]{64}$/.test(inStoreSourceHash) ||
      (env.POS_REQUIRE_SHIFT && env.POS_REQUIRE_SHIFT !== 'true'))) {
    throw new Error('In-store cash requires a separate reviewed live trading service, a distinct acceptance reference, a pinned stock source SHA-256, and mandatory shifts; never enable it on the read-only pilot.');
  }
  // An acceptance reference is NOT a way to revive the old POS-only stock pool
  // after these goods become shared online. Fail closed even if a service unit
  // was mistakenly amended and its env contains every former approval value.
  if (inStoreRequested && env.NODE_ENV !== 'test') {
    throw new Error('POS-only In-store cash is retired for shared WooCommerce stock. Keep this gate off; use a separately reviewed Woo-backed Wholesale checkout.');
  }
  // The old local ledger remains exercisable only by isolated test fixtures;
  // production and accidentally non-production live services cannot revive it.
  const inStoreCashEnabled = inStoreRequested && mode === 'live' && !liveReadOnly && env.NODE_ENV === 'test';
  if (env.POS_STAGING_APPROVED === 'true' && mode === 'staging' && !configured) throw new Error('Staging approval requires WooCommerce credentials.');
  if (env.POS_ALLOW_LIVE_WRITES === 'true' && mode === 'live' && !configured) throw new Error('Live writes require WooCommerce credentials.');

  // Phase 2 is a LOCAL synthetic test path, not a new production switch.
  // No combination of old live approval flags may turn it on. A separate
  // reviewed implementation/approval is needed before any real installation.
  if (env.POS_ONLINE_BRIDGE_LOCAL_TEST && !['true', 'false'].includes(env.POS_ONLINE_BRIDGE_LOCAL_TEST)) {
    throw new Error('POS_ONLINE_BRIDGE_LOCAL_TEST must be true or false.');
  }
  const onlineBridgeLocalTest = env.POS_ONLINE_BRIDGE_LOCAL_TEST === 'true';
  const bridgeUrl = env.POS_ONLINE_BRIDGE_URL || '';
  if (onlineBridgeLocalTest) {
    let parsed;
    try { parsed = new URL(bridgeUrl); } catch { throw new Error('Online bridge local test requires a loopback URL.'); }
    if (env.NODE_ENV !== 'test' || mode !== 'staging' || !writesEnabled || !configured ||
        env.POS_REQUIRE_SHIFT !== 'true' ||
        !['127.0.0.1', '[::1]'].includes(parsed.hostname) ||
        !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '') ||
        new URL(storeUrl).hostname !== parsed.hostname ||
        !env.POS_ONLINE_BRIDGE_APP_USER || !env.POS_ONLINE_BRIDGE_APP_PASSWORD ||
        (env.POS_ONLINE_BRIDGE_SECRET || '').length < 32 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.POS_ONLINE_BRIDGE_SITE_ID || '')) {
      throw new Error('Online bridge is restricted to an isolated test-only staging ledger, loopback Woo fixture, dedicated service credentials, site identity, approved test writes and mandatory shifts.');
    }
  }

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const bindHost = env.POS_BIND_HOST || '0.0.0.0';
  if (!['0.0.0.0', '127.0.0.1'].includes(bindHost)) throw new Error('POS_BIND_HOST must be 0.0.0.0 (container) or 127.0.0.1 (host-only proxy).');
  const lowStockThreshold = Number(env.POS_LOW_STOCK_THRESHOLD || 5);
  if (!Number.isInteger(lowStockThreshold) || lowStockThreshold < 1 || lowStockThreshold > 10000) throw new Error('POS_LOW_STOCK_THRESHOLD must be an integer from 1 to 10000.');
  const sessionIdleMinutes = Number(env.POS_SESSION_IDLE_MINUTES || 60);
  if (!Number.isInteger(sessionIdleMinutes) || sessionIdleMinutes < 5 || sessionIdleMinutes > 480) throw new Error('POS_SESSION_IDLE_MINUTES must be an integer from 5 to 480.');
  const reconcileIntervalSeconds = Number(env.POS_RECONCILE_INTERVAL_SECONDS || 60);
  if (!Number.isInteger(reconcileIntervalSeconds) || reconcileIntervalSeconds < 15 || reconcileIntervalSeconds > 3600) throw new Error('POS_RECONCILE_INTERVAL_SECONDS must be an integer from 15 to 3600.');

  return {
    mode, storeUrl, configured, liveReadOnly, writesEnabled, wholesaleWritesEnabled, approvalReference,
    inStoreCashEnabled, inStoreAcceptanceReference, inStoreSourceHash,
    desktopSetupEnabled, desktopEnabled, desktopDeviceMasterSecret,
    desktopAppUser: env.POS_DESKTOP_WP_APP_USER || '', desktopAppPassword: env.POS_DESKTOP_WP_APP_PASSWORD || '',
    onlineBridgeLocalTest, bridgeUrl: onlineBridgeLocalTest ? new URL(bridgeUrl).origin : '',
    bridgeSiteId: onlineBridgeLocalTest ? env.POS_ONLINE_BRIDGE_SITE_ID.toLowerCase() : '',
    bridgeAppUser: onlineBridgeLocalTest ? env.POS_ONLINE_BRIDGE_APP_USER : '',
    bridgeAppPassword: onlineBridgeLocalTest ? env.POS_ONLINE_BRIDGE_APP_PASSWORD : '',
    bridgeSecret: onlineBridgeLocalTest ? env.POS_ONLINE_BRIDGE_SECRET : '',
    consumerKey: env.WOO_CONSUMER_KEY || '', consumerSecret: env.WOO_CONSUMER_SECRET || '',
    dataDir: env.POS_DATA_DIR || path.resolve('.data'),
    port, bindHost, production, publicOrigin,
    trustProxy: env.POS_TRUST_PROXY || (production ? 'loopback' : '1'),
    ownerUsername: (env.POS_OWNER_USERNAME || '').toLowerCase().trim(), ownerPassword: env.POS_OWNER_PASSWORD || '',
    businessName: env.POS_BUSINESS_NAME || 'MansutRENDZGH',
    businessAddress: env.POS_BUSINESS_ADDRESS || '', businessPhone: env.POS_BUSINESS_PHONE || '', businessTaxId: env.POS_BUSINESS_TAX_ID || '',
    receiptFooter: env.POS_RECEIPT_FOOTER || 'Thank you for shopping with MansutRENDZGH.',
    receiptWidth: ['58', '80', 'a4'].includes(env.POS_RECEIPT_WIDTH) ? env.POS_RECEIPT_WIDTH : '80',
    orderStatus: env.POS_ORDER_STATUS === 'processing' ? 'processing' : 'completed',
    // First live rollout is cash-only. This is enforced on the server; a
    // changed browser or copied env flag cannot record MoMo/card as paid.
    paymentMethods: mode === 'live' || onlineBridgeLocalTest ? ['cash'] : ['cash', 'momo', 'card'],
    currency: 'GHS', lowStockThreshold,
    requireShift: env.POS_REQUIRE_SHIFT ? env.POS_REQUIRE_SHIFT === 'true' : mode !== 'demo',
    sessionIdleMinutes, reconcileIntervalSeconds,
    logLevel: env.POS_LOG_LEVEL || (production ? 'info' : 'debug'),
  };
}

// Centralize the background Woo order-sweep gate so a bridge-off ledger
// cannot quietly resume legacy reconciliation on restart. Manual bulk sweeps
// have a separate guard in SalesService.
export function shouldRunReconcileTimer(config) {
  return config.mode !== 'demo' && !config.liveReadOnly &&
    !config.onlineBridgeLocalTest && !config.onlineBridgeQuarantined && config.configured &&
    (config.mode !== 'live' || config.writesEnabled);
}

export function publicConfig(config) {
  return {
    mode: config.mode, storeUrl: config.storeUrl, configured: config.configured,
    liveReadOnly: config.liveReadOnly, writesEnabled: config.writesEnabled,
    wholesaleWritesEnabled: config.wholesaleWritesEnabled, inStoreCashEnabled: config.inStoreCashEnabled,
    onlineBridgeLocalTest: config.onlineBridgeLocalTest,
    onlineBridgeQuarantined: Boolean(config.onlineBridgeQuarantined),
    currency: config.currency,
    lowStockThreshold: config.lowStockThreshold, receiptFooter: config.receiptFooter,
    receiptWidth: config.receiptWidth, orderStatus: config.orderStatus,
    paymentMethods: config.paymentMethods, requireShift: config.requireShift, version: APP_VERSION,
    businessName: config.businessName, businessAddress: config.businessAddress,
    businessPhone: config.businessPhone, businessTaxId: config.businessTaxId,
  };
}
