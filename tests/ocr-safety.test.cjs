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
vm.runInContext(extract('function normalizeKnownQuantityConfirmations(', 'function getOCRSafetyIssues'), context);
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

test('OCR treats a confirmation checkbox as confirmed printed quantity, not handwritten quantity', () => {
  assert.match(html, /Галочка рядом с печатным количеством означает ПОДТВЕРЖДЕНИЕ/);
  assert.match(html, /quantity_status=\\\"confirmed\\\"/);
  assert.match(html, /НЕ добавляй строку в review\.handwritten_confirmation/);
  assert.match(html, /Рукописным считается только реально вписанное от руки ЧИСЛО количества/);
  assert.match(html, /Галочка, крестик, подчёркивание или иная отметка о проверке печатного числа не являются рукописным количеством/);
});

test('Rom baba checkbox is normalized to confirmed quantity before safety and comparison', () => {
  const json = JSON.stringify({
    schema_version: '1.0',
    document_type: 'combined',
    check_date: '2026-10-06',
    source: { photo_count: 1, processed_photo_count: 1, duplicate_photo_count: 0 },
    invoices: [{
      number: '123', date: '2026-10-06', continuation: false, last_line_number: 1,
      items: [{ line: 1, name: 'Ром баба', quantity: 2, quantity_status: 'handwritten' }]
    }],
    sales: [],
    review: { unreadable: [], handwritten_confirmation: ['Ром баба'], uncertain_rows: [], notes: [] }
  });
  const normalized = JSON.parse(context.normalizeKnownQuantityConfirmations(json));
  assert.equal(normalized.invoices[0].items[0].quantity_status, 'confirmed');
  assert.deepEqual(normalized.review.handwritten_confirmation, []);
  const issues = context.getOCRSafetyIssues(
    JSON.stringify(normalized),
    { hasBlocks: true, json: normalized },
    1
  );
  assert.equal(issues.some(x => x.code === 'quantity-status-review'), false);
  assert.equal(issues.some(x => x.code === 'handwritten-confirmation'), false);
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

test('OCR comparison does not fall back to audit date and can retain unconfirmed quantities for explicit confirmation', () => {
  assert.match(html, /const iso = String\(invDate \|\| ""\)\.trim\(\);/);
  assert.doesNotMatch(html, /String\(inv\.date\|\|d\.check_date\|\|""\)/);
  assert.match(html, /const status = String\(it\.quantity_status \|\| 'confirmed'\)/);
  assert.match(html, /status !== "confirmed" && !includeUnconfirmed/);
  assert.match(html, /incomingStatus/);
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
  assert.equal(issues.filter(x => x.code === 'handwritten-confirmation').length, 0);
  assert.match(issues.find(x => x.code === 'quantity-status-review').detail, /Безе мини ассорти/);
  assert.match(issues.find(x => x.code === 'quantity-status-review').detail, /Ром баба/);
});

test('double-run comparison ignores audit check_date and compares invoice data', () => {
  assert.match(html, /Дата аудита \(check_date\) не участвует в сравнении двух результатов/);
  assert.doesNotMatch(html, /const checkDateMismatch/);
  assert.doesNotMatch(html, /Дата проверки отличается/);
  assert.match(html, /\[d1full, 'Первый результат'\], \[d2full, 'Второй результат'\]/);
  assert.match(html, /Все позиции из обоих результатов есть в справочнике/);
  assert.match(html, /Первый результат.*Второй результат/);
});

test('double-run comparison remains valid when only audit check_date differs', () => {
  assert.match(html, /comparisonValid: quantityIssues\.length === 0 && otherSafetyIssues\.length === 0/);
  assert.doesNotMatch(html, /comparisonValid: !checkDateMismatch/);
  assert.match(html, /const comparisonBlocked = _cmpData\.comparisonValid === false/);
  assert.match(html, /!safetyBlocked && !comparisonBlocked/);
  assert.match(html, /Исправьте отмеченные строки перед применением/);
});

test('double-run comparison uses warning severity for unconfirmed quantities', () => {
  assert.match(html, /if \(aNeedsQty \|\| bNeedsQty\) \{/);
  assert.match(html, /if \(status === 'ok'\) status = 'warn';/);
  assert.match(html, /Количество не подтверждено · /);
  assert.match(html, /Есть только в /);
  assert.doesNotMatch(html, /Позиция есть только в /);
  assert.doesNotMatch(html, /Количество требует подтверждения — /);
});


test('double-run comparison exposes concrete row-level differences', () => {
  assert.match(html, /const details = \[\];/);
  assert.match(html, /Название не совпадает: «/);
  assert.match(html, /Приход не совпадает · .*↔/);
  assert.match(html, /Продажи не совпадают · .*↔/);
  assert.match(html, /cmp-detail/);
});


test('comparison safety gate clears resolved blocking issues', () => {
  assert.match(html, /_cmpData\.safetyIssues = unresolved;/);
  assert.match(html, /_cmpData\.comparisonValid = unresolved\.length === 0;/);
});


test('comparison issue review flow exposes filter, next-issue navigation, and live status recount', () => {
  assert.match(html, /id="cmpNextIssueBtn"/);
  assert.match(html, /data-filter="issues"/);
  assert.match(html, /function cmpGoToNextIssue\(\)/);
  assert.match(html, /function cmpApplyResultFilter\(filter\)/);
  assert.match(html, /_cmpData\.okCount = _cmpData\.rows\.filter/);
  assert.match(html, /Осталось проверить/);
});

test('OCR name mismatch can be explicitly confirmed and then stops blocking the row', () => {
  assert.match(html, /!row\.edits\?\.nameAccepted/);
  assert.match(html, /class="cmp-name-confirm"/);
  assert.match(html, /row\.edits\.nameAccepted = true/);
  assert.match(html, /Это одно и то же название/);
});

test('application version is consistent across runtime and visible UI', () => {
  assert.match(html, /const APP_VERSION = ['"]v9\.24\.20['"]/);
  assert.match(html, /id="moreAppVersion">v9\.24\.20</);
  assert.match(html, /id="aboutVersion">[^<]*v9\.24\.20</);
  assert.doesNotMatch(html, /v9\.24\.1[6-8]/);
});

test('double-run comparison merges likely OCR name variants into one row', () => {
  assert.match(html, /function cmpNameSimilarity\(a, b\)/);
  assert.match(html, /Возможное совпадение: «/);
  assert.match(html, /score >= 0\.72/);
  assert.match(html, /rows\.push\(\.\.\.mergedRows\)/);
  assert.match(html, /<div class="cmp-name"><div class="cmp-name-title">/);
  assert.match(html, /<div class="cmp-detail">/);
  assert.doesNotMatch(html, /Возможно, название прочитано иначе/);
});

test('OCR fuzzy name warnings are deduplicated and quantity statuses use plain language', () => {
  assert.match(html, /const fuzzySeen = new Set\(\)/);
  assert.match(html, /const issueKey = n \+ '\\|' \+ c/);
  assert.match(html, /количество записано от руки/);
  assert.match(html, /количество нужно уточнить/);
  assert.match(html, /Исправьте отмеченные строки перед применением/);
});


test('OCR safety does not duplicate handwritten confirmation when quantity status already identifies it', () => {
  const json = validJson({
    invoices: [{
      number: '123', date: '2026-10-06', continuation: false,
      last_line_number: 1, printed_total: null,
      items: [{ line: 1, name: 'Безе мини ассорти', quantity: 3, quantity_status: 'handwritten' }]
    }],
    review: {
      unreadable: [],
      handwritten_confirmation: ['Безе мини ассорти'],
      uncertain_rows: [],
      notes: []
    }
  });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 2);
  assert.equal(issues.filter(x => x.code === 'quantity-status-review').length, 1);
  assert.equal(issues.filter(x => x.code === 'handwritten-confirmation').length, 0);
});
