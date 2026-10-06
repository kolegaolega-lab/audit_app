'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(source, name, endMarker) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing production function: ${name}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Could not find end of production function: ${name}`);
  return source.slice(start, end);
}

const context = {
  MAX_NUM: 100000,
  SHELF_LIFE_START_HOUR: 7,
  WRITE_OFF_HOUR: 22,
  getCheckMoment: () => new Date(2026, 9, 3, 12, 0, 0),
  clampNum(v, min, max, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  },
  emptyResult: () => ({ soldExpired: null, expiredOnShelf: null, freshOnShelf: null, freshSold: null }),
  mergeIncomingByDate: rows => [...(rows || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))
};
vm.createContext(context);
vm.runInContext(extractFunction(html, 'getWriteOffMoment', 'function parseDateRu('), context);
vm.runInContext(extractFunction(html, 'computeFIFO', 'function emptyResult('), context);

const computeFIFO = (...args) => JSON.parse(JSON.stringify(context.computeFIFO(...args)));
const expiry = (date, hours) => context.getWriteOffMoment(date, hours);
const row = (shelfLife, incoming, stock, sales) => ({ shelfLife, incoming, stock, sales });

test('24h expires same day at 22:00', () => {
  const d = expiry('2026-10-03', 24);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 3);
  assert.equal(d.getHours(), 22);
});

test('36h expires next day at 19:00', () => {
  const d = expiry('2026-10-03', 36);
  assert.equal(d.getDate(), 4);
  assert.equal(d.getHours(), 19);
});

test('48h expires next day at 22:00', () => {
  const d = expiry('2026-10-03', 48);
  assert.equal(d.getDate(), 4);
  assert.equal(d.getHours(), 22);
});

test('72h expires two days later at 22:00', () => {
  const d = expiry('2026-10-03', 72);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 22);
});

test('96h expires three days later at 22:00', () => {
  const d = expiry('2026-10-03', 96);
  assert.equal(d.getDate(), 6);
  assert.equal(d.getHours(), 22);
});

test('user case: 24h, received 2, stock 3 => 2 fresh and 1 expired', () => {
  assert.deepEqual(computeFIFO(row(24, [{date:'2026-10-03', qty:2}], 3, 0)),
    { freshOnShelf:2, expiredOnShelf:1, freshSold:0, soldExpired:0 });
});

test('FIFO sells oldest lot first', () => {
  assert.deepEqual(computeFIFO(row(48, [
    {date:'2026-10-01', qty:2},
    {date:'2026-10-02', qty:3}
  ], 1, 4)), { freshOnShelf:1, expiredOnShelf:0, freshSold:2, soldExpired:2 });
});

test('expired sales are detected from expired lots', () => {
  assert.deepEqual(computeFIFO(row(24, [{date:'2026-10-02', qty:2}], 0, 2)),
    { freshOnShelf:0, expiredOnShelf:0, freshSold:0, soldExpired:2 });
});

test('sales beyond known receipts are not treated as fresh', () => {
  assert.deepEqual(computeFIFO(row(48, [{date:'2026-10-03', qty:2}], 0, 5)),
    { freshOnShelf:0, expiredOnShelf:0, freshSold:2, soldExpired:3 });
});

test('stock beyond known receipts is not treated as fresh', () => {
  assert.deepEqual(computeFIFO(row(24, [{date:'2026-10-03', qty:1}], 3, 0)),
    { freshOnShelf:1, expiredOnShelf:2, freshSold:0, soldExpired:0 });
});

test('no receipts means stock and sales are flagged as unconfirmed/expired', () => {
  assert.deepEqual(computeFIFO(row(24, [], 1, 2)),
    { freshOnShelf:0, expiredOnShelf:1, freshSold:0, soldExpired:2 });
});
