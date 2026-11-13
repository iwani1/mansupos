import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryGroups, stockAlerts } from '../src/catalog-insights.js';

test('category directory uses the loaded product assignments without duplicating a style', () => {
  const categories = categoryGroups([
    { name: 'Dress one', category: 'Dresses', categories: ['Dresses', 'Dresses', 'New'], image: 'dress.jpg' },
    { name: 'Dress two', category: 'Dresses', categories: [], image: '' },
    { name: 'Shirt', category: 'Tops', categories: ['Tops'], image: 'top.jpg' },
  ]);
  assert.deepEqual(categories, [
    { name: 'Dresses', count: 2, image: 'dress.jpg' },
    { name: 'New', count: 1, image: 'dress.jpg' },
    { name: 'Tops', count: 1, image: 'top.jpg' },
  ]);
});

test('stock watch list counts a shared Woo parent pool once and separates independent options', () => {
  const make = (id, stockSource, stock, name = 'Shared dress') => ({ id, stockSource, stock, manageStock: true, name, image: '', label: `Option ${id}` });
  const products = [
    { id: 10, name: 'Shared dress', type: 'variable', image: 'dress.jpg', variations: [
      make(101, 'parent', 3), make(102, 'parent', 3), make(103, 'variation', 5),
    ] },
    { id: 20, name: 'Sold out', type: 'simple', image: '', ...make(20, 'product', 0, 'Sold out') },
    { id: 30, name: 'Missing owner', type: 'simple', image: '', ...make(30, 'unknown', 1, 'Missing owner') },
    { id: 40, name: 'Untracked', type: 'simple', image: '', stockSource: 'untracked', manageStock: false, stock: null },
  ];
  const watch = stockAlerts(products, 5, true);
  assert.deepEqual(watch.low.map(item => [item.key, item.stock, item.option]), [
    ['10:parent', 3, 'Shared across options'], ['10:103', 5, 'Option 103'],
  ]);
  assert.deepEqual(watch.out.map(item => [item.key, item.stock]), [['20:0', 0]]);
  assert.equal(watch.low[0].image, 'dress.jpg');
});

test('unconfirmed live stock ownership is omitted, but old demo stock remains sample-only', () => {
  const products = [{ id: 1, type: 'simple', name: 'Sample', image: '', manageStock: true, stock: 2 }];
  assert.equal(stockAlerts(products, 5, true).low.length, 0);
  assert.equal(stockAlerts(products, 5, false).low.length, 1);
});
