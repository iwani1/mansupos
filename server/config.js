import 'dotenv/config';
import path from 'node:path';

export const APP_VERSION = '1.1.6';
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
  if (env.POS_STAGING_APPROVED === 'true' && mode === 'staging' && !configured) throw new Error('Staging approval requires WooCommerce credentials.');
  if (env.POS_ALLOW_LIVE_WRITES === 'true' && mode === 'live' && !configured) throw new Error('Live writes require WooCommerce credentials.');

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
    paymentMethods: mode === 'live' ? ['cash'] : ['cash', 'momo', 'card'],
    currency: 'GHS', lowStockThreshold,
    requireShift: env.POS_REQUIRE_SHIFT ? env.POS_REQUIRE_SHIFT === 'true' : mode !== 'demo',
    sessionIdleMinutes, reconcileIntervalSeconds,
    logLevel: env.POS_LOG_LEVEL || (production ? 'info' : 'debug'),
  };
}

export function publicConfig(config) {
  return {
    mode: config.mode, storeUrl: config.storeUrl, configured: config.configured,
    liveReadOnly: config.liveReadOnly, writesEnabled: config.writesEnabled,
    wholesaleWritesEnabled: config.wholesaleWritesEnabled, currency: config.currency,
    lowStockThreshold: config.lowStockThreshold, receiptFooter: config.receiptFooter,
    receiptWidth: config.receiptWidth, orderStatus: config.orderStatus,
    paymentMethods: config.paymentMethods, requireShift: config.requireShift, version: APP_VERSION,
    businessName: config.businessName, businessAddress: config.businessAddress,
    businessPhone: config.businessPhone, businessTaxId: config.businessTaxId,
  };
}
