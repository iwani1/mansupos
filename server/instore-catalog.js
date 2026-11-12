import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { AppError } from './errors.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const requiredColumns = ['Name', 'ProductGroup', 'SKU', 'Barcode', 'MeasurementUnit', 'Price', 'IsEnabled'];
const sha256 = value => createHash('sha256').update(value).digest('hex');

// Final, all-in CSV unit prices must already be payable in whole pesewas.
// NEVER silently round 194.1177, infer a tax rate, or accept an input price.
function parseCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value || '').trim());
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  return cents > 0n && cents <= 100000000n ? Number(cents) : null;
}

export function sourceProblem(message) {
  return new AppError(`In-store stock source needs owner review: ${message}`, 503, 'INSTORE_SOURCE_REVIEW');
}
const validFileName = name => typeof name === 'string' && name === path.basename(name) && name !== '.' && name !== '..';
const comparable = name => String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

export function buildInStoreSnapshot(products, stockSnapshot) {
  if (!Array.isArray(products) || !Array.isArray(stockSnapshot?.rows) || !Array.isArray(stockSnapshot.unidentifiedReportRows)) {
    throw sourceProblem('invalid or incomplete report format.');
  }
  const reportRows = new Set();
  const checkReportRow = row => {
    if (!Number.isInteger(row.reportRow) || row.reportRow < 1 || row.reportRow > products.length ||
        !Number.isInteger(row.page) || row.page < 1 || reportRows.has(row.reportRow)) {
      throw sourceProblem('missing or duplicate stock report row.');
    }
    reportRows.add(row.reportRow);
  };
  const quantities = new Map();
  for (const row of stockSnapshot.rows) {
    checkReportRow(row);
    if (!/^\d{1,8}$/.test(String(row.sku || '')) || quantities.has(String(row.sku)) ||
        (row.quantity !== null && (!Number.isInteger(row.quantity) || Math.abs(row.quantity) > 1000000)) ||
        typeof row.unit !== 'string') throw sourceProblem('invalid or duplicate stock report code/quantity.');
    quantities.set(String(row.sku), row);
  }
  for (const row of stockSnapshot.unidentifiedReportRows) {
    checkReportRow(row);
    if (typeof row.name !== 'string' || !row.name.trim() ||
        (row.quantity !== null && (!Number.isInteger(row.quantity) || Math.abs(row.quantity) > 1000000))) {
      throw sourceProblem('invalid unidentified stock report row.');
    }
  }
  if (reportRows.size !== products.length || [...reportRows].some(number => number > products.length)) {
    throw sourceProblem('product and report row counts do not match.');
  }
  const identifiers = new Set();
  const barcodeCounts = new Map();
  for (const product of products) {
    const barcode = String(product.Barcode || '').trim();
    if (barcode) barcodeCounts.set(barcode, (barcodeCounts.get(barcode) || 0) + 1);
  }
  let unidentifiedIndex = 0;
  const items = products.map((product, index) => {
    const sku = String(product.SKU || '').trim();
    const name = String(product.Name || '').trim();
    const barcode = String(product.Barcode || '').trim();
    const group = String(product.ProductGroup || '').trim() || 'Uncategorised';
    const priceCents = parseCents(product.Price);
    const entry = sku ? quantities.get(sku) : stockSnapshot.unidentifiedReportRows[unidentifiedIndex++];
    const reasons = [];
    if (!sku) {
      reasons.push('SKU missing in CSV and stock report; identify this item before sale.');
      if (!entry || comparable(entry.name) !== comparable(name)) throw sourceProblem('unidentified product name does not match its report row.');
    } else if (identifiers.has(sku)) throw sourceProblem('duplicate product SKU.');
    else identifiers.add(sku);
    if (!name) reasons.push('Product name missing.');
    if (!entry && sku) reasons.push('SKU not found in stock report.');
    if (entry && (!Number.isInteger(entry.quantity) || entry.quantity < 0)) reasons.push('Negative or unknown stock; physically recount.');
    if (String(product.MeasurementUnit || '').trim().toLowerCase() !== 'each' ||
        (entry && String(entry.unit || '').toLowerCase() !== 'each')) reasons.push('Missing or malformed unit of measure.');
    if (priceCents === null) reasons.push('Price is missing or not a positive two-decimal GHS amount.');
    if (barcode && barcodeCounts.get(barcode) > 1) reasons.push('Barcode is duplicated.');
    if (product.IsEnabled !== '1') reasons.push('Item is disabled in the product export.');
    const status = reasons.length ? 'review' : entry.quantity === 0 ? 'out_of_stock' : 'available';
    return {
      key: sku || `unidentified-${index + 1}`, sku, name, group, barcode,
      priceCents, reportedQuantity: entry?.quantity ?? null,
      stock: status === 'review' ? null : entry.quantity,
      status, reviewReasons: reasons, reportRow: entry?.reportRow ?? null,
    };
  });
  if (identifiers.size !== quantities.size || [...identifiers].some(sku => !quantities.has(sku)) ||
      unidentifiedIndex !== stockSnapshot.unidentifiedReportRows.length ||
      products.length - identifiers.size !== stockSnapshot.unidentifiedCsvRows) {
    throw sourceProblem('product and stock codes do not match exactly.');
  }
  const summary = {
    items: items.length, available: items.filter(item => item.status === 'available').length,
    outOfStock: items.filter(item => item.status === 'out_of_stock').length,
    needsReview: items.filter(item => item.status === 'review').length,
    unidentified: items.filter(item => !item.sku).length,
    source: stockSnapshot.sourcePdf, salesEnabled: false,
  };
  return { source: 'in-store-physical-stock-snapshot', storeOnly: true, summary, items };
}

export function loadInStoreSnapshot(rootDir = projectRoot) {
  try {
    const manifest = fs.readFileSync(path.join(rootDir, 'data/instore-stock-snapshot.json'));
    const data = JSON.parse(manifest.toString('utf8'));
    if (!validFileName(data.sourceCsv) || !validFileName(data.sourcePdf)) throw sourceProblem('invalid source filename.');
    const csvFile = fs.readFileSync(path.join(rootDir, data.sourceCsv));
    const pdfFile = fs.readFileSync(path.join(rootDir, data.sourcePdf));
    if (sha256(csvFile) !== data.csvSha256 || sha256(pdfFile) !== data.pdfSha256) {
      throw sourceProblem('the product CSV or stock PDF has changed since review.');
    }
    const products = parse(csvFile, { bom: true, skip_empty_lines: true,
      columns(columns) {
        if (new Set(columns).size !== columns.length || requiredColumns.some(column => !columns.includes(column))) {
          throw sourceProblem('missing or duplicate product columns.');
        }
        return columns;
      },
    });
    return { ...buildInStoreSnapshot(products, data), manifestHash: sha256(manifest),
      csvHash: data.csvSha256, pdfHash: data.pdfSha256 };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw sourceProblem('files could not be read or parsed.');
  }
}
