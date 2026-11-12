import { z } from 'zod';
import { audit } from './db.js';
import { AppError, now } from './errors.js';
import { freshLine } from './woocommerce.js';

// Private POS-only defaults. WooCommerce remains the sole owner of retail
// prices, product identities and stock; these values never become Woo metadata.
const identitySchema = z.object({
  productName: z.string().max(500), parentSku: z.string().max(500),
  optionSku: z.string().max(500), optionLabel: z.string().max(500),
  optionAttributes: z.string().max(5000), retailPriceCents: z.number().int().min(0),
}).strict();
export const priceInputSchema = z.object({
  priceCents: z.number().int().min(1).max(100000000),
  expectedRevision: z.number().int().min(0),
  expectedIdentity: identitySchema,
}).strict();
export const priceRemovalSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();

const optionSignature = attributes => JSON.stringify((attributes || []).map(attribute => [attribute.name, attribute.option]));
const snapshot = (product, option) => ({
  productName: product.name, parentSku: product.sku || '',
  optionSku: option?.sku || '', optionLabel: option?.label || '',
  optionAttributes: optionSignature(option?.attributes), retailPriceCents: option?.price ?? product.price,
});
const rowView = row => ({
  productId: row.product_id, variationId: row.variation_id,
  productName: row.product_name, parentSku: row.parent_sku,
  optionSku: row.option_sku, optionLabel: row.option_label,
  optionAttributes: row.option_attributes, retailPriceCents: row.retail_price_cents,
  priceCents: row.unit_price_cents, revision: row.revision,
  updatedAt: row.updated_at, updatedBy: row.updated_by,
});
const matches = (a, b) => Object.keys(b).every(key => a[key] === b[key]);
const changed = () => new AppError('This wholesale price changed. Refresh the price list and review it before saving.', 409, 'PRICE_CHANGED');

export class WholesalePrices {
  constructor(db, catalog, api, config) { this.db = db; this.catalog = catalog; this.api = api; this.config = config; }

  checkWorkspace() {
    if (this.config.liveReadOnly) throw new AppError('Private wholesale prices are not managed on the read-only catalogue pilot.', 403, 'CHECKOUT_LOCKED');
  }

  async list() {
    this.checkWorkspace();
    const rows = this.db.prepare('SELECT * FROM wholesale_prices ORDER BY product_id, variation_id').all();
    if (!rows.length) return { prices: [] };
    // Never suggest a saved price for a stale/incomplete catalogue, a deleted
    // option or a changed product/attribute/retail price. Leave the old row for
    // an explicit owner re-review or removal, rather than silently remapping it.
    const catalogue = await this.catalog.get();
    const trustworthy = this.config.mode === 'demo' || (!catalogue.stale && catalogue.complete === true);
    const products = new Map((catalogue.products || []).map(product => [product.id, product]));
    return { prices: rows.map(row => {
      const record = rowView(row);
      const product = products.get(record.productId);
      const option = record.variationId ? product?.variations.find(v => v.id === record.variationId) : null;
      const validType = product && (record.variationId === 0 ? product.type === 'simple' : product.type === 'variable' && option);
      return { ...record, valid: Boolean(trustworthy && validType && matches(record, snapshot(product, option))) };
    }) };
  }

  async identity(productId, variationId) {
    if (this.config.mode === 'demo') {
      const product = this.catalog.demo().find(p => p.id === productId);
      const option = variationId ? product?.variations.find(v => v.id === variationId) : null;
      if (!product || (product.type === 'variable' && !option) || (product.type !== 'variable' && variationId)) {
        throw new AppError('Product option not found in this catalogue.', 404);
      }
      return snapshot(product, option);
    }
    // Fresh authenticated Woo reads, not a cached browser price or historical
    // CSV, decide which exact product/option receives the private price.
    const line = await freshLine(this.api, productId, variationId);
    const current = {
      productName: line.name, parentSku: line.parentSku, optionSku: line.optionSku,
      optionLabel: line.label, optionAttributes: optionSignature(line.optionAttributes), retailPriceCents: line.price,
    };
    if (!identitySchema.safeParse(current).success) {
      throw new AppError('WooCommerce returned an invalid product or retail price. Do not save a wholesale default.', 409, 'CATALOG_CHANGED');
    }
    return current;
  }

  async save(user, productId, variationId, { priceCents, expectedRevision, expectedIdentity }) {
    this.checkWorkspace();
    const identity = await this.identity(productId, variationId);
    if (!matches(expectedIdentity, identity)) {
      throw new AppError('The Woo product, option or retail price changed while you were editing. Refresh the catalogue and reopen this price.', 409, 'CATALOG_CHANGED');
    }
    // Both the version comparison AND the edit/audit commit atomically. A
    // globally increasing version prevents old editors winning an ABA race
    // when the same ID is removed and later added again.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT revision FROM wholesale_prices WHERE product_id=? AND variation_id=?').get(productId, variationId);
      if ((existing?.revision || 0) !== expectedRevision) throw changed();
      const revision = Number(this.db.prepare('INSERT INTO wholesale_price_revisions DEFAULT VALUES').run().lastInsertRowid);
      const changedAt = now();
      if (existing) {
        this.db.prepare(`UPDATE wholesale_prices SET product_name=?, parent_sku=?, option_sku=?, option_label=?, option_attributes=?,
          retail_price_cents=?, unit_price_cents=?, revision=?, updated_at=?, updated_by=?
          WHERE product_id=? AND variation_id=?`)
          .run(identity.productName, identity.parentSku, identity.optionSku, identity.optionLabel, identity.optionAttributes,
            identity.retailPriceCents, priceCents, revision, changedAt, user.id, productId, variationId);
      } else {
        this.db.prepare(`INSERT INTO wholesale_prices
          (product_id,variation_id,product_name,parent_sku,option_sku,option_label,option_attributes,
           retail_price_cents,unit_price_cents,revision,updated_at,updated_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(productId, variationId, identity.productName, identity.parentSku, identity.optionSku,
            identity.optionLabel, identity.optionAttributes, identity.retailPriceCents, priceCents, revision, changedAt, user.id);
      }
      audit(this.db, user.id, 'wholesale.price_saved', `${productId}:${variationId}`);
      const saved = rowView(this.db.prepare('SELECT * FROM wholesale_prices WHERE product_id=? AND variation_id=?').get(productId, variationId));
      this.db.exec('COMMIT');
      return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  remove(user, productId, variationId, { expectedRevision }) {
    this.checkWorkspace();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.db.prepare('DELETE FROM wholesale_prices WHERE product_id=? AND variation_id=? AND revision=?')
        .run(productId, variationId, expectedRevision);
      if (!removed.changes) throw changed();
      audit(this.db, user.id, 'wholesale.price_removed', `${productId}:${variationId}`);
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
