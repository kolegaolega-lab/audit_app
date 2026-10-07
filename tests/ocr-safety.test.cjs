'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(start, end) {
  const a = html.indexOf(start);
  assert.notEqual(a, -1, 'missing: ' + start);
  const b = html.indexOf(end, a);
  assert.notEqual(b, -1, 'missing: ' + end);
  return html.slice(a, b);
}

const context = {};
vm.createContext(context);
vm.runInContext(extract('function normalizeName(', 'function cleanProductName'), context);
vm.runInContext(extract('function getOCRSafetyIssues(', 'function formatOCRSafetyMessage'), context);
vm.runInContext(extract('function validateAIResponse(', 'function getOCRSafetyIssues'), context);

function validJson(overrides = {}) {
  return JSON.stringify({
    schema_version: '1.0',
    document_type: 'combined',
    check_date: '2026-10-06',
    source: { photo_count: 2, processed_photo_count: 2, duplicate_photo_count: 0 },
    invoices: [{
      number: '123',
      date: '2026-10-06',
      continuation: false,
      last_line_number: 2,
      printed_total: 100,
      items: [{
        line: 1,
        name: 'Пончик с фисташкой',
        quantity: 2,
        quantity_status: 'confirmed',
        price: 50,
        amount: 100
      }]
    }],
    sales: [{
      name: 'Пончик с фисташкой',
      quantity: 1,
      quantity_status: 'confirmed'
    }],
    review: {
      unreadable: [],
      handwritten_confirmation: [],
      uncertain_rows: [],
      notes: []
    },
    ...overrides
  });
}

function reportFor(json) {
  return { hasBlocks: true, json: JSON.parse(json) };
}

test('OCR safety rejects empty or invalid JSON', () => {
  assert.ok(context.getOCRSafetyIssues('', null, 2).some(x => x.code === 'empty-json'));
  assert.ok(context.getOCRSafetyIssues('{bad', null, 2).some(x => x.code === 'empty-json'));
});

test('OCR safety checks that every photo was processed', () => {
  const json = validJson({ source: { photo_count: 2, processed_photo_count: 1, duplicate_photo_count: 0 } });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 2);
  assert.ok(issues.some(x => x.code === 'completeness-mismatch'));
});

test('OCR safety blocks unreadable, handwritten and uncertain quantities', () => {
  const json = validJson({
    review: {
      unreadable: ['строка 4'],
      handwritten_confirmation: ['строка 7'],
      uncertain_rows: ['К-во: 2 или 3'],
      notes: []
    }
  });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 2);
  const codes = issues.map(x => x.code);
  assert.ok(codes.includes('unreadable'));
  assert.ok(codes.includes('handwritten-confirmation'));
  assert.ok(codes.includes('uncertain-rows'));
});

test('OCR safety blocks any non-confirmed quantity status', () => {
  const json = validJson({
    invoices: [{
      number: '123', date: '2026-10-06', continuation: false,
      last_line_number: 1, printed_total: null,
      items: [{ line: 1, name: 'Товар', quantity: 3, quantity_status: 'handwritten', price: null, amount: null }]
    }]
  });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 2);
  assert.ok(issues.some(x => x.code === 'quantity-status-review'));
});

test('client validation catches quantity × price mismatch', () => {
  const json = validJson({
    invoices: [{
      number: '123', date: '2026-10-06', continuation: false,
      last_line_number: 1, printed_total: null,
      items: [{ line: 1, name: 'Товар', quantity: 3, quantity_status: 'confirmed', price: 50, amount: 100 }]
    }]
  });
  const result = context.validateAIResponse(json, '', reportFor(json), 2);
  assert.ok(result.issues.some(x => x.code === 'line-quantity-mismatch'));
});

test('OCR prompt enforces column 8 piece count and never derives quantity from money', () => {
  assert.match(html, /колонка 8[^\n]*мест, штук/);
  assert.match(html, /Не вычисляй quantity через цену или сумму/);
  assert.match(html, /Дубликаты фото не суммировать/);
});

test('OCR prompt keeps the full document and applies category only after OCR', () => {
  assert.match(html, /OCR обязан распознать все товарные позиции документа/);
  assert.match(html, /распознай ВЕСЬ раздел продаж/);
  assert.match(html, /Если товарной позиции НЕТ в справочнике — всё равно включи её в JSON/);
  assert.doesNotMatch(html, /В JSON включай ТОЛЬКО те позиции, которые есть в списке ниже/);
  assert.match(html, /p&&_activeCategory&&p\.category!==_activeCategory/);
});

test('OCR validation catches duplicate rows inside one invoice', () => {
  const json = validJson({
    invoices: [{
      number: '123', date: '2026-10-06', continuation: false,
      last_line_number: 2, printed_total: null,
      items: [
        { line: 1, name: 'Товар', quantity: 2, quantity_status: 'confirmed', price: 10, amount: 20 },
        { line: 2, name: 'Товар', quantity: 3, quantity_status: 'confirmed', price: 10, amount: 30 }
      ]
    }]
  });
  const result = context.validateAIResponse(json, '', reportFor(json), 2);
  assert.ok(result.issues.some(x => x.code === 'duplicate-row'));
});

test('OCR validation catches suspicious quantity patterns', () => {
  const quantities = [2,2,2,2,2,2,2,2,2,25];
  const json = validJson({
    invoices: [{
      number: '123', date: '2026-10-06', continuation: false,
      last_line_number: quantities.length, printed_total: null,
      items: quantities.map((q, i) => ({
        line: i + 1, name: 'Товар ' + (i + 1), quantity: q,
        quantity_status: 'confirmed', price: 10, amount: q * 10
      }))
    }]
  });
  const result = context.validateAIResponse(json, '', reportFor(json), 2);
  assert.ok(result.issues.some(x => x.code === 'qty-outlier'));
  assert.ok(result.issues.some(x => x.code === 'qty-stuck'));
});

test('OCR validation does not flag a normal short run of equal quantities', () => {
  const quantities = [3,3,3,3,3,1,2,1];
  const json = validJson({
    invoices: [{
      number: '123', date: '2026-10-06', continuation: false,
      last_line_number: quantities.length, printed_total: null,
      items: quantities.map((q, i) => ({
        line: i + 1, name: 'Товар ' + (i + 1), quantity: q,
        quantity_status: 'confirmed', price: 10, amount: q * 10
      }))
    }]
  });
  const result = context.validateAIResponse(json, '', reportFor(json), 2);
  assert.equal(result.issues.some(x => x.code === 'qty-stuck'), false);
});

test('OCR safety accepts duplicate photos only when processing count still matches', () => {
  const json = validJson({
    source: { photo_count: 3, processed_photo_count: 3, duplicate_photo_count: 1 }
  });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 3);
  assert.equal(issues.some(x => x.code === 'completeness-mismatch'), false);
});

test('production code uses structured JSON output and no legacy CSV parser', () => {
  assert.match(html, /responseMimeType\s*:\s*["']application\/json["']/);
  assert.match(html, /responseSchema\s*:\s*OCR_JSON_SCHEMA/);
  assert.match(html, /temperature\s*:\s*0/);
  assert.match(html, /thinkingConfig\s*:\s*\{\s*thinkingLevel\s*:\s*["']low["']/);
  assert.match(html, /async function recognizeWithGemini/);
  assert.match(html, /async function recognizeDaily/);
  assert.match(html, /function buildSeparatedOCRPrompt/);
  assert.match(html, /function mergeSeparatedOCRJson/);
  assert.doesNotMatch(html, /function detectDelimiter\(/);
  assert.doesNotMatch(html, /function parseJSONtoArray\(/);
  assert.doesNotMatch(html, /function parseNum\(/);
  assert.doesNotMatch(html, /function stripServiceSections\(/);
  assert.doesNotMatch(html, /async\s+async\s+function/);
});
