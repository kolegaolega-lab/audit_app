import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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
