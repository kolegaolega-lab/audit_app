/* Tests the real computeFIFO() source from index.html without a browser.
 * Run: node --test tests/fifo.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Missing production function: ${name}`);
  const endMarker = name === 'computeFIFO' ? '\\nfunction emptyResult()' : null;
  const end = endMarker ? source.indexOf(endMarker, start) : -1;
  assert.notEqual(end, -1, `Could not find end of production function: ${name}`);
  return source.slice(start, end);
}

const productionFunction = extractFunction(html, 'computeFIFO');
const FIXED_NOW = new Date(2026, 9, 3, 12, 0, 0);
const context = {
  MAX_NUM: 100000,
  SHELF_LIFE_START_HOUR: 7,
  getCheckMoment: () => new Date(FIXED_NOW),
  clampNum: (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  },
  emptyResult: () => ({ soldExpired: null, expiredOnShelf: null, freshOnShelf: null, freshSold: null }),
  mergeIncomingByDate: rows => [...(rows || [])].sort((a, b) => a.date.localeCompare(b.date)),
  getWriteOffMoment: (date, hours) => {
    if (!date || !Number.isFinite(Number(hours))) return null;
    const days = Math.max(0, Math.ceil(Number(hours) / 24) - 1);
    const d = new Date(date + 'T07:00:00');
    d.setDate(d.getDate() + days);
    d.setHours(22, 0, 0, 0);
    return d;
  }
};
vm.createContext(context);
vm.runInContext(productionFunction, context);
const computeFIFO = context.computeFIFO;
const row = (shelfLife, incoming, stock, sales) => ({ shelfLife, incoming, stock, sales });

test('user case: 24h cottage ring reserves fresh display stock, sales all flagged', () => {
  assert.deepEqual({ ...computeFIFO(row(24, [{date:'2026-10-03',qty:2}], 3, 3)) },
    { freshOnShelf:2, expiredOnShelf:1, freshSold:0, soldExpired:3 });
});

test('user case: 48h éclair keeps fresh stock and assigns oldest lot to sales', () => {
  assert.deepEqual({ ...computeFIFO(row(48, [
    {date:'2026-10-01',qty:2}, {date:'2026-10-02',qty:3}
  ], 2, 4)) }, { freshOnShelf:2, expiredOnShelf:0, freshSold:1, soldExpired:3 });
});

test('24h lot expires at 22:00 on receipt date', () => {
  const expiry = context.getWriteOffMoment('2026-10-03', 24);
  assert.equal(expiry.getHours(), 22);
  assert.equal(expiry.getDate(), 3);
});

test('36h and 48h lots expire next day at 22:00', () => {
  for (const hours of [36, 48]) {
    const expiry = context.getWriteOffMoment('2026-10-03', hours);
    assert.equal(expiry.getDate(), 4);
    assert.equal(expiry.getHours(), 22);
  }
});

test('72h lot expires two calendar days later at 22:00', () => {
  const expiry = context.getWriteOffMoment('2026-10-03', 72);
  assert.equal(expiry.getDate(), 5);
  assert.equal(expiry.getHours(), 22);
});

test('sales can use a lot expiring today at 22:00, stock cannot after expiry', () => {
  const result = computeFIFO(row(24, [{date:'2026-10-03',qty:2}], 0, 2));
  assert.deepEqual({ ...result }, { freshOnShelf:0, expiredOnShelf:0, freshSold:2, soldExpired:0 });
});

test('stock beyond all fresh and expired receipts is flagged, not silently fresh', () => {
  const result = computeFIFO(row(24, [{date:'2026-10-03',qty:1}], 3, 0));
  assert.deepEqual({ ...result }, { freshOnShelf:1, expiredOnShelf:2, freshSold:0, soldExpired:0 });
});

test('sales beyond remaining confirmed receipts are flagged', () => {
  const result = computeFIFO(row(48, [{date:'2026-10-03',qty:2}], 0, 5));
  assert.deepEqual({ ...result }, { freshOnShelf:0, expiredOnShelf:0, freshSold:2, soldExpired:3 });
});

test('no incoming, stock and sales are both unconfirmed', () => {
  const result = computeFIFO(row(24, [], 1, 2));
  assert.deepEqual({ ...result }, { freshOnShelf:0, expiredOnShelf:1, freshSold:0, soldExpired:2 });
});

test('zero stock with no sales produces no violations', () => {
  const result = computeFIFO(row(24, [{date:'2026-10-03',qty:4}], 0, 0));
  assert.deepEqual({ ...result }, { freshOnShelf:0, expiredOnShelf:0, freshSold:0, soldExpired:0 });
});
