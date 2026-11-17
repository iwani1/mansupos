import test from 'node:test';
import assert from 'node:assert/strict';
import { available, takesLastUnit, onBackorder, stockUnknown } from '../src/stock.js';

// Register stock rules the cashier sees. Pure logic, no browser needed.
const tracked = stock => ({ purchasable: true, manageStock: true, stock, stockStatus: stock > 0 ? 'instock' : 'outofstock', backorders: 'no' });

test('last-unit warning appears only when the cart takes every tracked unit', () => {
  assert.equal(takesLastUnit(tracked(1), 1), true);
  assert.equal(takesLastUnit(tracked(3), 3), true);
  assert.equal(takesLastUnit(tracked(3), 2), false);
  assert.equal(takesLastUnit({ ...tracked(1), backorders: 'yes' }, 1), false, 'backorderable items are not a last unit');
  assert.equal(takesLastUnit({ purchasable: true, manageStock: false, stock: null }, 1), false, 'untracked items have no last unit');
  assert.equal(takesLastUnit({ ...tracked(1), stock: null }, 1), false, 'unknown quantity is handled by the stock-unknown rule');
});

test('availability: tracked items need stock, unknown ownership is never sellable', () => {
  assert.equal(available(tracked(2)), true);
  assert.equal(available(tracked(0)), false);
  assert.equal(available({ ...tracked(2), stockSource: 'unknown' }), false);
  assert.equal(available({ ...tracked(2), purchasable: false }), false);
  assert.equal(stockUnknown({ ...tracked(2), stock: null }), true);
  assert.equal(onBackorder({ ...tracked(0), backorders: 'notify', stockStatus: 'onbackorder' }), true);
});
