import { z } from 'zod';

export const deviceIdSchema = z.string().uuid();
export const stockKeySchema = z.string().regex(/^[1-9]\d*:(?:0|[1-9]\d*)$/);
export const grantSchema = z.object({
  stockKey: stockKeySchema, productId: z.number().int().positive(), variationId: z.number().int().min(0),
  remaining: z.number().int().min(0).max(1000000), revision: z.number().int().min(1),
  expiresAt: z.string().datetime(),
}).strict();
export const offlineLineSchema = z.object({
  productId: z.number().int().positive(), variationId: z.number().int().min(0),
  stockKey: stockKeySchema, quantity: z.number().int().min(1).max(999),
  name: z.string().min(1).max(500), label: z.string().max(500), sku: z.string().max(500),
  price: z.number().int().min(1).max(100000000),
  agreedUnitPrice: z.number().int().min(1).max(100000000).optional(),
}).strict();
export const saleEventSchema = z.object({
  kind: z.literal('sale'), id: z.string().uuid(), deviceId: deviceIdSchema,
  cashierId: z.string().uuid(), cashierName: z.string().min(1).max(80),
  saleType: z.enum(['retail', 'wholesale']), buyerName: z.string().max(120),
  approvedById: z.string().uuid().nullable(), approvedByName: z.string().max(80),
  paymentMethod: z.enum(['cash', 'momo']), paymentReference: z.string().max(80),
  paymentStatus: z.enum(['cash_received', 'unverified']),
  tendered: z.number().int().min(0).max(1000000000), total: z.number().int().min(1).max(1000000000),
  items: z.array(offlineLineSchema).min(1).max(100), note: z.string().max(250),
  createdAt: z.string().datetime(), grantRevisions: z.record(stockKeySchema, z.number().int().min(1)),
}).strict();
export const returnEventSchema = z.object({
  kind: z.literal('return'), id: z.string().uuid(), deviceId: deviceIdSchema, saleId: z.string().uuid(),
  actorId: z.string().uuid(), actorName: z.string().min(1).max(80),
  items: z.array(z.object({ productId: z.number().int().positive(), variationId: z.number().int().min(0),
    stockKey: stockKeySchema, quantity: z.number().int().min(1).max(999), amount: z.number().int().min(1) }).strict()).min(1).max(100),
  amount: z.number().int().positive().max(1000000000), reason: z.string().trim().min(5).max(250),
  cashRefunded: z.literal(true), createdAt: z.string().datetime(),
}).strict();
export const syncEventSchema = z.discriminatedUnion('kind', [saleEventSchema, returnEventSchema]);

const stockSource = z.enum(['product','variation','parent','untracked','unknown']);
const optionSnapshot = z.object({ id:z.number().int().positive(), label:z.string().max(500), sku:z.string().max(500),
  price:z.number().int().min(0).max(100000000), stockSource, manageStock:z.boolean(),
  purchasable:z.boolean(), backordersAllowed:z.boolean(), stockStatus:z.string().max(40) }).passthrough();
const productSnapshot = z.object({ id:z.number().int().positive(), name:z.string().min(1).max(500),
  type:z.enum(['simple','variable']), sku:z.string().max(500), price:z.number().int().min(0).max(100000000),
  stockSource, manageStock:z.boolean(), purchasable:z.boolean(), backordersAllowed:z.boolean(),
  stockStatus:z.string().max(40), variations:z.array(optionSnapshot).max(1000) }).passthrough();
// A bootstrap is only accepted if the central backend explicitly authorizes a
// single enrolled till, a time-limited lease, and Woo-enforced allocations.
// A plain catalogue or an online flag can never become selling authority.
export const bootstrapSchema = z.object({
  deviceId: deviceIdSchema, canSell: z.boolean(), canWholesale: z.boolean(), leaseExpiresAt: z.string().datetime(),
  catalog: z.object({ products: z.array(productSnapshot).max(10000), source: z.literal('woocommerce'),
    complete: z.literal(true), stale: z.literal(false), fetchedAt: z.string().datetime() }).passthrough(),
  wholesalePrices: z.array(z.unknown()).max(10000), grants: z.array(grantSchema).max(10000),
}).strict().superRefine((data,ctx)=>{
  const products=new Map(),options=new Set(),grants=new Set();
  for(const product of data.catalog.products){
    if(products.has(product.id))ctx.addIssue({code:'custom',message:'Duplicate Woo product ID in snapshot.'});
    products.set(product.id,product);
    for(const option of product.variations){
      if(options.has(option.id))ctx.addIssue({code:'custom',message:'Duplicate Woo variation ID in snapshot.'});
      options.add(option.id);
    }
  }
  for(const grant of data.grants){
    if(grants.has(grant.stockKey)||grant.stockKey!==`${grant.productId}:${grant.variationId}`)
      ctx.addIssue({code:'custom',message:'Duplicate or mismatched Woo stock pool in grant.'});
    grants.add(grant.stockKey);
    const product=products.get(grant.productId);
    const ownsPool=product && (grant.variationId
      ? product.type==='variable' && product.variations.some(v=>v.id===grant.variationId && v.stockSource==='variation')
      : product.type==='simple' && product.stockSource==='product' ||
        product.type==='variable' && product.variations.some(v=>v.stockSource==='parent'));
    if(!ownsPool)ctx.addIssue({code:'custom',message:'Grant does not belong to the cached Woo catalogue or its stock-managed option.'});
  }
  if(data.canWholesale&&!data.canSell)ctx.addIssue({code:'custom',message:'Wholesale cannot be enabled while offline checkout is locked.'});
});

export const returnInputSchema = z.object({
  idempotencyKey: z.string().uuid(), saleId: z.string().uuid(),
  items: z.array(z.object({ productId: z.number().int().positive(), variationId: z.number().int().min(0), quantity: z.number().int().min(1).max(999) }).strict()).min(1).max(100),
  reason: z.string().trim().min(5).max(250), cashRefunded: z.literal(true),
}).strict();

export const allocationInputSchema = z.object({
  idempotencyKey: z.string().uuid(), deviceId: deviceIdSchema,
  productId: z.number().int().positive(), variationId: z.number().int().min(0),
  quantity: z.number().int().min(1).max(1000),
}).strict();
