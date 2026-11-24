// Add and edit website product listings.
import express from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { productSchema, productUpdateSchema } from '../products.js';

export function registerProductRoutes(app, ctx) {
  const { products, auth, role, sensitiveLimit } = ctx;
  // Add / edit website product listings (owner and manager).
  const productId = value => z.coerce.number().int().positive().max(2 ** 31).parse(value);
  app.get('/api/products/setup', auth, role('owner', 'manager'), async (_req, res) => res.json(await products.setup()));
  app.post('/api/products/media', auth, role('owner', 'manager'), sensitiveLimit,
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AppError('Send one photo as JPEG, PNG or WebP.', 400);
      res.status(201).json(await products.uploadImage(req.user, req.body, String(req.query.name || '').slice(0, 80)));
    });
  app.post('/api/products', auth, role('owner', 'manager'), sensitiveLimit, async (req, res) => res.status(201).json(await products.create(req.user, productSchema.parse(req.body))));
  app.get('/api/products/:id/edit', auth, role('owner', 'manager'), async (req, res) => res.json({ product: await products.editable(productId(req.params.id)) }));
  app.put('/api/products/:id', auth, role('owner', 'manager'), sensitiveLimit, async (req, res) => res.json(await products.update(req.user, productId(req.params.id), productUpdateSchema.parse(req.body))));
}
