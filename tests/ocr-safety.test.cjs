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

const context = { MAX_NUM: 100000, getTodayStr() { return '2026-10-07'; }, safeDate(y,m,d) { const x=new Date(y,m-1,d); return x.getFullYear()===y && x.getMonth()===m-1 && x.getDate()===d ? `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` : null; } };
vm.createContext(context);
vm.runInContext(extract('function normalizeName(', 'function cleanProductName'), context);
vm.runInContext(extract('function parseDateRu(', 'function inferIsoFromDdmm'), context);
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
  assert.match(html, /OCR parser intentionally keeps all categories/);
  assert.doesNotMatch(html, /if\(p&&_activeCategory&&p\.category&&p\.category!==_activeCategory\)return null;/);
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


test('recognizeWithGemini validates before applying the OCR safety gate', () => {
  const validationPos = html.indexOf('if (p1) p1.validation = validateAIResponse(a, b, p1, items.length);');
  const safetyPos = Math.min(
    ...[
      html.indexOf('const rawSafety = [...getOCRSafetyIssues(a, p1, items.length)'),
      html.indexOf('const s = [...getOCRSafetyIssues(a, p1, items.length)')
    ].filter(pos => pos >= 0)
  );
  assert.ok(validationPos >= 0 && Number.isFinite(safetyPos) && validationPos < safetyPos);
});

test('manual JSON import runs the production validator before OCR safety', () => {
  const validationPos = html.indexOf('safetyReport.validation = validateAIResponse(text, text, safetyReport');
  const safetyPos = html.indexOf('const safetyIssues = getOCRSafetyIssues(text, safetyReport');
  assert.ok(validationPos >= 0 && safetyPos >= 0 && validationPos < safetyPos);
});

test('OCR safety blocks validation errors that could otherwise reach applyJSON', () => {
  const json = validJson();
  const report = { hasBlocks: true, validation: { issues: [{ level: 'error', code: 'line-quantity-mismatch' }] } };
  const issues = context.getOCRSafetyIssues(json, report, 2);
  assert.ok(issues.some(x => x.code === 'validation-errors'));
});

test('OCR safety blocks malformed confirmed quantities', () => {
  const json = validJson({
    invoices: [{
      number: '123', date: '2026-10-06', continuation: false, last_line_number: 2,
      items: [{ line: 1, name: 'Пончик с фисташкой', quantity: -2, quantity_status: 'confirmed' }]
    }]
  });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 2);
  assert.ok(issues.some(x => x.code === 'invalid-quantity'));
});

test('OCR safety rejects invalid document structure and check date', () => {
  const json = validJson({ check_date: '31.02.2026', invoices: {}, sales: [] });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 2);
  const codes = issues.map(x => x.code);
  assert.ok(codes.includes('invalid-check-date'));
  assert.ok(codes.includes('invalid-document-arrays'));
});

test('OCR compare does not fall back to audit date and ignores unconfirmed quantities', () => {
  assert.match(html, /const iso = String\(invDate \|\| ""\)\.trim\(\);/);
  assert.doesNotMatch(html, /String\(inv\.date\|\|d\.check_date\|\|""\)/);
  assert.match(html, /it\.quantity_status !== "confirmed"/);
});


test('manual JSON import invokes the same OCR safety gate before parsing rows', () => {
  assert.match(html, /const safetyIssues = getOCRSafetyIssues\(text, safetyReport/);
  assert.match(html, /if \(safetyIssues\.length\) throw new Error\(formatOCRSafetyMessage\(safetyIssues\)\)/);
});


test('OCR safety blocks future audit and invoice dates', () => {
  const futureAudit = validJson({ check_date: '2026-10-08' });
  const futureAuditCodes = context.getOCRSafetyIssues(futureAudit, reportFor(futureAudit), 2).map(x => x.code);
  assert.ok(futureAuditCodes.includes('future-check-date'));

  const futureInvoice = validJson({
    invoices: [{
      number: '123', date: '2026-10-07', continuation: false, last_line_number: 1,
      items: [{ line: 1, name: 'Пончик с фисташкой', quantity: 2, quantity_status: 'confirmed' }]
    }]
  });
  const futureInvoiceCodes = context.getOCRSafetyIssues(futureInvoice, reportFor(futureInvoice), 2).map(x => x.code);
  assert.ok(futureInvoiceCodes.includes('future-invoice-date'));
});


test('OCR safety consolidates non-confirmed quantities into one actionable issue', () => {
  const json = validJson({
    invoices: [{
      number: '123', date: '2026-10-06', continuation: false,
      last_line_number: 2, printed_total: null,
      items: [
        { line: 1, name: 'Безе мини ассорти', quantity: 3, quantity_status: 'handwritten' },
        { line: 2, name: 'Ром баба', quantity: 2, quantity_status: 'handwritten' }
      ]
    }],
    review: {
      unreadable: [],
      handwritten_confirmation: ['Безе мини ассорти', 'Ром баба'],
      uncertain_rows: [],
      notes: []
    }
  });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 2);
  assert.equal(issues.filter(x => x.code === 'quantity-status-review').length, 1);
  assert.equal(issues.filter(x => x.code === 'handwritten-confirmation').length, 1);
  assert.match(issues.find(x => x.code === 'quantity-status-review').detail, /Безе мини ассорти/);
  assert.match(issues.find(x => x.code === 'quantity-status-review').detail, /Ром баба/);
});

test('double-run comparison checks differing check dates and both-run catalog integrity', () => {
  assert.match(html, /Дата проверки отличается между прогонами/);
  assert.match(html, /\[d1full, 'Прогон 1'\], \[d2full, 'Прогон 2'\]/);
  assert.match(html, /Все позиции обоих JSON есть в справочнике/);
  assert.match(html, /Прогон 1.*Прогон 2/);
});

test('double-run comparison exposes concrete row-level differences', () => {
  assert.match(html, /const details = \[\];/);
  assert.match(html, /Название: «/);
  assert.match(html, /Приход .*↔/);
  assert.match(html, /Продажи: .*↔/);
  assert.match(html, /cmp-detail/);
});


test('double-run comparison detects likely OCR name variants without merging rows', () => {
  assert.match(html, /function cmpNameSimilarity\(a, b\)/);
  assert.match(html, /Возможный OCR-вариант/);
  assert.match(html, /score >= 0\.72/);
  assert.match(html, /Это НЕ объединяет строки и не меняет FIFO-данные/);
});
