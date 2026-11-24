// Builds the settings one platform shop runs with, from its registry record and
// decrypted credentials. Built from scratch: nothing is inherited from the
// platform process's own environment, so one shop can never pick up another
// shop's (or the single-shop server's) keys or approvals.
export function buildShopEnv(shop, secrets, platform, { owner, access, entitlements } = {}) {
  // A shop whose trial/payment has lapsed keeps everything except selling and
  // website writes (computeAccess / entitlements in billing.js).
  const selling = entitlements ? entitlements.canSell : shop.stage === 'selling';
  const features = entitlements ? entitlements.features : shop.features;
  const env = {
    NODE_ENV: platform.nodeEnv,
    POS_TENANT_ID: shop.id,
    POS_MODE: 'live',
    POS_DATA_DIR: platform.shopDir(shop),
    POS_PUBLIC_ORIGIN: platform.shopOrigin(shop.slug),
    POS_TRUST_PROXY: platform.trustProxy,
    POS_LOG_LEVEL: platform.logLevel,
    WOO_BASE_URL: shop.storeUrl,
    POS_BUSINESS_NAME: shop.name,
    POS_LIVE_READ_ONLY: selling ? 'false' : 'true',
    POS_REQUIRE_SHIFT: 'true',
  };
  if (secrets.woo_key && secrets.woo_secret) {
    env.WOO_CONSUMER_KEY = secrets.woo_key;
    env.WOO_CONSUMER_SECRET = secrets.woo_secret;
  }
  if (secrets.wp_media_user && secrets.wp_media_password) {
    env.POS_WP_MEDIA_USER = secrets.wp_media_user;
    env.POS_WP_MEDIA_APP_PASSWORD = secrets.wp_media_password;
  }
  if (selling) {
    // The platform's go-live step stands in for the single-shop owner approval
    // reference: selling is cash-only retail straight to WooCommerce.
    env.POS_ALLOW_LIVE_WRITES = 'true';
    env.POS_LIVE_RETAIL_CASH_DIRECT = 'true';
    env.POS_OWNER_APPROVAL_REFERENCE = `platform-go-live:${shop.id}`;
    env.POS_INVENTORY_WRITES_APPROVED = features.inventoryWrites ? 'true' : 'false';
    env.POS_PRODUCT_WRITES_APPROVED = features.productWrites ? 'true' : 'false';
    env.POS_RETURNS_APPROVED = features.returns ? 'true' : 'false';
  }
  const business = shop.business || {};
  if (business.address) env.POS_BUSINESS_ADDRESS = business.address;
  if (business.phone) env.POS_BUSINESS_PHONE = business.phone;
  if (business.taxId) env.POS_BUSINESS_TAX_ID = business.taxId;
  if (business.receiptFooter) env.POS_RECEIPT_FOOTER = business.receiptFooter;
  if (business.receiptWidth) env.POS_RECEIPT_WIDTH = business.receiptWidth;
  env.POS_PLATFORM_STAGE = shop.stage;
  if (access) env.POS_PLATFORM_BILLING = [access.state, access.until || '', access.graceUntil || '', access.plan].join('|');
  if (entitlements?.maxStaff) env.POS_MAX_STAFF = String(entitlements.maxStaff);
  if (owner) {
    env.POS_OWNER_USERNAME = owner.username;
    if (owner.passwordHash) env.POS_OWNER_PASSWORD_HASH = owner.passwordHash;
    else env.POS_OWNER_PASSWORD = owner.password;
    if (owner.name) env.POS_OWNER_NAME = owner.name;
  }
  return env;
}
