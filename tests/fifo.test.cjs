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
  getCheckMoment: (value) => { const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : new Date(2026, 9, 3, 12, 0, 0); },
  clampNum(v, min, max, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  },
  emptyResult: () => ({ soldExpired: null, expiredOnShelf: null, freshOnShelf: null, freshSold: null }),
  mergeIncomingByDate: rows => [...(rows || [])].sort((a, b) => String(a.date).localeCompare(String(b.date))),
  getTodayStr() { return '2026-10-06'; },
  parseDateRu(value, referenceDate) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : '';
  }
};
vm.createContext(context);
vm.runInContext(extractFunction(html, 'getWriteOffMoment', 'function parseDateRu('), context);
vm.runInContext(extractFunction(html, 'computeFIFO', 'function emptyResult('), context);
vm.runInContext(extractFunction(html, 'hasUsableIncomingForAudit', 'function formatOCRSafetyMessage('), context);

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

test('60h expires two days later at 19:00', () => {
  const d = expiry('2026-10-03', 60);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 19);
});

test('24h boundary is 22:00, not next morning', () => {
  const d = expiry('2026-10-03', 24);
  assert.equal(d.toISOString().slice(0, 16), '2026-10-03T22:00');
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

test('no receipts means stock and sales are flagged as expired', () => {
  assert.deepEqual(computeFIFO(row(24, [], 1, 2)),
    { freshOnShelf:0, expiredOnShelf:1, freshSold:0, soldExpired:2 });
});

test('no receipt means sales are expired even when actual stock has not been entered', () => {
  assert.deepEqual(computeFIFO(row(48, [], null, 3)), {
    soldExpired: 3, expiredOnShelf: null, freshOnShelf: null, freshSold: 0
  });
});

test('audit date and start time stay tied to the historical sales report, not the phone date', () => {
  const controls = { autoDate: { value: '' }, autoTime: { value: '' } };
  const dateContext = {
    tableRows: [{
      _checkDate: '2026-09-25',
      _checkMoment: new Date(2026, 9, 14, 13, 45, 0).getTime()
    }],
    $: id => controls[id] || null,
    getTodayStr: () => '2026-10-14',
    formatDateRu: value => value,
    getCurrentTimeStr: () => '00:30'
  };
  vm.createContext(dateContext);
  vm.runInContext(extractFunction(html, 'getCheckMoment', 'function getWriteOffMoment('), dateContext);
  vm.runInContext(extractFunction(html, 'getAuditCheckDate', 'function updateAutoDate('), dateContext);
  vm.runInContext(extractFunction(html, 'getAuditCheckMoment', 'function updateAutoDate('), dateContext);
  vm.runInContext(extractFunction(html, 'updateAutoDate', 'function updateAutoTime('), dateContext);
  vm.runInContext(extractFunction(html, 'updateAutoTime', 'function startAutoDateTime('), dateContext);
  assert.equal(dateContext.getAuditCheckDate(), '2026-09-25');
  dateContext.updateAutoDate();
  dateContext.updateAutoTime();
  assert.equal(controls.autoDate.value, '2026-09-25');
  assert.equal(controls.autoTime.value, '13:45');
});


test('future receipts are ignored for the audit date', () => {
  assert.deepEqual(computeFIFO(row(24, [{date:'2026-10-04', qty:5}], 3, 0)), {
    freshOnShelf:0, expiredOnShelf:3, freshSold:0, soldExpired:0
  });
});

test('future receipts do not make sales fresh', () => {
  assert.deepEqual(computeFIFO(row(24, [{date:'2026-10-04', qty:5}], 0, 2)), {
    freshOnShelf:0, expiredOnShelf:0, freshSold:0, soldExpired:2
  });
});

test('future receipt plus valid receipt uses only valid receipt', () => {
  assert.deepEqual(computeFIFO(row(24, [
    {date:'2026-10-03', qty:2},
    {date:'2026-10-04', qty:5}
  ], 3, 0)), {
    freshOnShelf:2, expiredOnShelf:1, freshSold:0, soldExpired:0
  });
});

test('future receipt is ignored even when it has a larger quantity than stock', () => {
  assert.deepEqual(computeFIFO(row(48, [{date:'2026-10-05', qty:100}], 1, 1)), {
    freshOnShelf:0, expiredOnShelf:1, freshSold:0, soldExpired:1
  });
});


test('regression: OCR merge must preserve all invoice dates needed by FIFO', () => {
  assert.match(html, /invoices: normalizedInvoices,/);
  assert.doesNotMatch(html, /invoices:\s*normalizedInvoices\.filter\(x\s*=>\s*String\(x\.date\s*\|\|\s*''\)\s*===\s*iso\)/);
});

test('regression: missing invoice date must never fall back to audit date', () => {
  assert.match(html, /else\{activeInvoiceDate="";date=""\}/);
  assert.doesNotMatch(html, /const fallback=String\(d\.check_date/);
});

test('regression: unresolved continuation date must remain unresolved', () => {
  assert.match(html, /let activeInvoiceDate = ""/);
  assert.match(html, /copy\.date = \(number && invoiceDates\[number\]\) \|\| activeInvoiceDate \|\| ""/);
  assert.doesNotMatch(html, /lastInvoiceDate/);
});

test('regression: missing invoice dates are blocking OCR safety issues', () => {
  assert.match(html, /code:"invoice-date-review"/);
  assert.match(html, /level:\s*['"]error['"][\s\S]{0,120}code:\s*inv\?\.continuation\s*\?\s*['"]continuation-date-unresolved['"]\s*:\s*['"]invoice-date-missing['"]/);
});

test('regression: duplicate incoming summary is removed from product cards', () => {
  assert.doesNotMatch(html, /card-result-source/);
  assert.doesNotMatch(html, /getIncomingSummary\(/);
});


test('future receipt does not count as a usable incoming for the audit date', () => {
  const r = context.hasUsableIncomingForAudit({
    _checkDate: '2026-10-06',
    incoming: [{ date: '2026-10-07', qty: 10 }]
  });
  assert.equal(r, false);
});

test('receipt on or before audit date counts as usable incoming', () => {
  const r = context.hasUsableIncomingForAudit({
    _checkDate: '2026-10-06',
    shelfLife: 24, incoming: [{ date: '2026-10-06', qty: 10 }]
  });
  assert.equal(r, true);
});

test('receipt outside shelf-life window is not a usable incoming', () => {
  assert.equal(context.hasUsableIncomingForAudit({
    _checkDate: '2026-10-06',
    shelfLife: 24,
    incoming: [{ date: '2026-10-04', qty: 10 }]
  }), false);
});

test('receipt inside shelf-life window is a usable incoming', () => {
  assert.equal(context.hasUsableIncomingForAudit({
    _checkDate: '2026-10-06',
    shelfLife: 48,
    incoming: [{ date: '2026-10-05', qty: 10 }]
  }), true);
});


test('regression: full OCR diagnostics retain unknown names, but working reconciliation requires a catalog match', () => {
  assert.match(html, /const catalogKey = normalizeName\(cleanProductName\(a\)\)/);
  assert.match(html, /const p = _cmpProductIndexCache\.get\(catalogKey\)/);
  assert.match(html, /if \(applyCategory && \(!p \|\| \(_activeCategory && p\.category !== _activeCategory\)\)\) return null;/);
  assert.match(html, /const d1full = cmpParseJSON\(t1, false, true\);\s*const d2full = cmpParseJSON\(t2, false, true\);\s*const d1 = cmpParseJSON\(t1, true, true\);\s*const d2 = cmpParseJSON\(t2, true, true\);/);
  assert.match(html, /hasUnrepresentedUnconfirmedIncoming/);
});

test('session persists and restores the audit date used by FIFO', () => {
  assert.match(html, /checkDate: \(\(\) =>/);
  assert.match(html, /_checkDate: data\.checkDate/);
  assert.match(html, /const SESSION_VERSION = 7/);
});
