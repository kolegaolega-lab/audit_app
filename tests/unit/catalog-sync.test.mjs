import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function validateRemoteCatalog(');
const end = html.indexOf('function syncPullFromServer(', start);
assert.notEqual(start, -1, 'production validator must exist');
assert.notEqual(end, -1, 'validator must end before syncPullFromServer');
const validatorSource = html.slice(start, end);

const context = {
  MAX_CATALOG: 5000,
  MAX_NAME: 120,
  safeStr(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; },
  normalizeName(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); },
  sanitizeProducts(rows) {
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    return rows.filter(p => p && typeof p.name === 'string' && p.name.trim())
      .map(p => ({ name: p.name.trim(), shelfLife: Number(p.shelfLife) || null, category: p.category || null }))
      .filter(p => { const key = p.name.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  }
};
const validate = new Function('sanitizeProducts', 'safeStr', 'normalizeName', `${validatorSource}; return validateRemoteCatalog;`)(
  context.sanitizeProducts, context.safeStr, context.normalizeName
);

const product = { name: 'Пончик', shelfLife: 48, category: 'Десерты' };
const point = { id: 'shop-1', num: '001', name: 'Точка 1', address: 'Адрес' };

test('remote catalog rejects missing, malformed and empty product payloads', () => {
  assert.equal(validate(null).ok, false);
  assert.equal(validate({ products: {} }).reason, 'invalid-products');
  assert.equal(validate({ products: [] }).reason, 'empty-products');
  assert.equal(validate({ products: [{ name: '' }] }).reason, 'empty-products');
});

test('remote catalog rejects malformed optional sections before applying any section', () => {
  assert.equal(validate({ products: [product], ignored: {} }).reason, 'invalid-ignored');
  assert.equal(validate({ products: [product], aliases: {} }).reason, 'invalid-aliases');
  assert.equal(validate({ products: [product], prices: [] }).reason, 'invalid-prices');
  assert.equal(validate({ products: [product], points: {} }).reason, 'invalid-points');
});

test('empty or wholly invalid remote point list is rejected to protect local point data', () => {
  assert.equal(validate({ products: [product], points: [] }).reason, 'invalid-points');
  assert.equal(validate({ products: [product], points: [{ id: '', num: '' }] }).reason, 'invalid-points');
});

test('valid payload and legacy payload without optional sections remain accepted', () => {
  assert.equal(validate({ products: [product], points: [point], ignored: [], aliases: [], prices: {} }).ok, true);
  assert.equal(validate({ products: [product] }).ok, true);
});

test('sync validates the entire remote envelope before the first local mutation', () => {
  const syncStart = html.indexOf('function syncPullFromServer(');
  const syncEnd = html.indexOf('async function syncPushToServer(', syncStart);
  const syncSource = html.slice(syncStart, syncEnd);
  const validationAt = syncSource.indexOf('validateRemoteCatalog(remote)');
  const mutationAt = syncSource.indexOf('PRODUCTS = cleaned; saveCatalog();');
  assert.notEqual(validationAt, -1);
  assert.ok(mutationAt > validationAt, 'local products must not be changed before validation succeeds');
  assert.match(syncSource, /Локальные данные сохранены/);
});

test('silent point sync rejects duplicate IDs and normalized point numbers', () => {
  const start = html.indexOf('async function pullPointsSilently()');
  const end = html.indexOf('/* ═', start);
  assert.notEqual(start, -1, 'silent point sync must exist');
  assert.notEqual(end, -1, 'silent point sync must have a bounded source section');
  const source = html.slice(start, end);
  assert.match(source, /const seenIds = new Set\(\)/);
  assert.match(source, /const seenNums = new Set\(\)/);
  assert.match(source, /normalizeName\(num\)/);
  assert.match(source, /seenIds\.has\(id\) \|\| seenNums\.has\(numKey\)/);
  assert.match(source, /Array\.isArray\(p\)/, 'array-shaped records must be ignored');
});

test('adding a point uses the same normalized number comparison as remote sync', () => {
  const start = html.indexOf('function addPoint(');
  const end = html.indexOf('function removePoint(', start);
  assert.notEqual(start, -1, 'addPoint must exist');
  assert.notEqual(end, -1, 'addPoint source section must be bounded');
  const source = html.slice(start, end);
  assert.match(source, /const numKey = normalizeName\(n\)/);
  assert.match(source, /_points\.some\(p => normalizeName\(p\.num\) === numKey\)/);
  assert.doesNotMatch(source, /p\.num\.toLowerCase\(\) === n\.toLowerCase\(\)/);
});

test('removing the active point updates the active-point UI and removes it from today route', () => {
  const start = html.indexOf('function removePoint(');
  const end = html.indexOf('function getPointById(', start);
  assert.notEqual(start, -1, 'removePoint must exist');
  assert.notEqual(end, -1, 'removePoint source must be bounded');
  const calls = [];
  const context = {
    _points: [{id:'p1',num:'001'}, {id:'p2',num:'002'}],
    _activePointId: 'p1',
    _route: {date:'2026-10-09',pointIds:['p1','p2']},
    POINTS_KEY: 'points',
    ACTIVE_POINT_KEY: 'active',
    localStorage: {
      values: new Map([['active','p1']]),
      setItem(key,value) { this.values.set(key,String(value)); },
      removeItem(key) { this.values.delete(key); }
    },
    savePoints() {},
    saveRoute() { calls.push('saveRoute'); },
    updatePointsCount() {},
    updateHeaderPoint() { calls.push('updateHeaderPoint'); },
    syncActivePointToInput() { calls.push('syncActivePointToInput'); },
    renderToday() { calls.push('renderToday'); }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.removePoint('p1');
  assert.deepEqual(Array.from(context._points, p => p.id), ['p2']);
  assert.equal(context._activePointId, 'p2');
  assert.equal(context.localStorage.values.get('active'), 'p2');
  assert.deepEqual(Array.from(context._route.pointIds), ['p2']);
  assert.ok(calls.includes('saveRoute'));
  assert.ok(calls.includes('updateHeaderPoint'));
  assert.ok(calls.includes('syncActivePointToInput'));
  assert.ok(calls.includes('renderToday'));
});

test('removing the last active point clears persisted selection and synchronizes UI', () => {
  const start = html.indexOf('function removePoint(');
  const end = html.indexOf('function getPointById(', start);
  const calls = [];
  const pointInput = {value:'001'};
  const context = {
    _points: [{id:'p1',num:'001'}],
    _activePointId: 'p1',
    _route: {date:'2026-10-09',pointIds:['p1']},
    ACTIVE_POINT_KEY: 'active',
    pointInput,
    $ (id) { return id === 'point' ? pointInput : null; },
    localStorage: {
      values: new Map([['active','p1']]),
      setItem(key,value) { this.values.set(key,String(value)); },
      removeItem(key) { this.values.delete(key); }
    },
    savePoints() {},
    saveRoute() {},
    updatePointsCount() {},
    updateHeaderPoint() { calls.push('updateHeaderPoint'); },
    syncActivePointToInput() { calls.push('syncActivePointToInput'); },
    renderToday() {}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.removePoint('p1');
  assert.equal(context._activePointId, null);
  assert.equal(context.localStorage.values.has('active'), false);
  assert.deepEqual(Array.from(context._route.pointIds), []);
  assert.ok(calls.includes('updateHeaderPoint'));
  assert.equal(context.pointInput.value, '');
  assert.equal(calls.includes('syncActivePointToInput'), false);
});

test('loading saved points removes duplicate normalized numbers and malformed records', () => {
  const start = html.indexOf('function loadPoints(');
  const end = html.indexOf('function savePoints(', start);
  assert.notEqual(start, -1, 'loadPoints must exist');
  assert.notEqual(end, -1, 'loadPoints source must be bounded');
  const context = {
    POINTS_KEY: 'points',
    localStorage: { getItem() { return JSON.stringify([
      {id:'p1',num:'001',name:'First'},
      {id:'p2',num:' 001 ',name:'Duplicate whitespace'},
      {id:'p3',num:'00-2',name:'Normalized duplicate'},
      {id:'p4',num:'00 2',name:'Normalized duplicate two'},
      ['array-shaped'],
      {id:'p5',num:'003',name:'Third'}
    ]); } },
    safeStr(value, max) { return typeof value === 'string' ? value.slice(0,max) : ''; },
    normalizeName(value) { return String(value || '').trim().toLowerCase().replace(/[-\\s]+/g,' '); }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.deepEqual(Array.from(context.loadPoints(), p => p.id), ['p1','p3','p5']);
});

test('history filenames are unique while the parser preserves point and login', () => {
  const buildStart = html.indexOf('function buildHistoryFilename(');
  const buildEnd = html.indexOf('function buildCheckSnapshot(', buildStart);
  const parseStart = html.indexOf('function parseHistoryFilename(');
  const parseEnd = html.indexOf('async function fetchHistoryMonthFolder(', parseStart);
  assert.notEqual(buildStart, -1);
  assert.notEqual(buildEnd, -1);
  assert.notEqual(parseStart, -1);
  assert.notEqual(parseEnd, -1);
  let tick = 1791540672000;
  let randomIndex = 0;
  class FixedDate extends Date {
    constructor() { super('2026-10-09T10:11:12Z'); }
    static now() { return tick++; }
  }
  const randomValues = [0.123456789, 0.987654321];
  const context = {
    Date: FixedDate,
    Math: { random() { return randomValues[randomIndex++ % randomValues.length]; } },
    HISTORY_DIR: 'history',
    getActivePoint() { return {id:'p1'}; },
    _profile: {login:'auditor',name:'Auditor'}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(buildStart, buildEnd), context);
  vm.runInContext(html.slice(parseStart, parseEnd), context);
  const firstPath = context.buildHistoryFilename();
  const secondPath = context.buildHistoryFilename();
  assert.notEqual(firstPath, secondPath, 'two checks in the same second must not share a file path');
  const firstName = firstPath.split('/').pop();
  const parsed = JSON.parse(JSON.stringify(context.parseHistoryFilename(firstName)));
  assert.equal(parsed.pointId, 'p1');
  assert.equal(parsed.login, 'auditor');
  assert.equal(parsed.day, 9);
  assert.match(parsed.timeHH, /^\\d{2}$/, 'time must remain parseable across local time zones');
  assert.equal(context.parseHistoryFilename('09-101112-p1-auditor.json').pointId, 'p1', 'legacy history filenames remain supported');
});

test('history sending writes to the unique path and does not reuse a recent file by point alone', () => {
  const start = html.indexOf('async function sendReportToHistory(');
  const end = html.indexOf('async function pullPointsSilently(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end);
  assert.match(source, /await pushHistoryFile\(defaultPath, snapshot\)/);
  assert.doesNotMatch(source, /findRecentTwin/);
});
