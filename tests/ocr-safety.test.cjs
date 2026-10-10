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
vm.runInContext(extract('function cmpCanonicalName(', 'function cmpNameSimilarity'), context);
vm.runInContext(extract('function cmpConfirmSameName(', 'function cmpRenderEditCard'), context);
vm.runInContext(extract('function normalizeKnownQuantityConfirmations(', 'function getOCRSafetyIssues'), context);
vm.runInContext(extract('function fmtDateRuShort(', 'function getTodayStr'), context);
vm.runInContext(extract('function parseDateRu(', 'function inferIsoFromDdmm'), context);
vm.runInContext(extract('function cmpUpdateOCRJsonWithCorrections(', 'function cmpSyncAppliedCorrectionsToOCR'), context);
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

test('confirming equivalent OCR names persists an alias to the catalog product', () => {
  const aliases = [];
  context.PRODUCTS = [{ name: 'Лингвини с жареными креветками' }];
  context.addOrUpdateAlias = (alias, target) => { aliases.push({ alias, target }); return true; };
  const row = {
    a: { name: 'Лингвини с жаренными креветками' },
    b: { name: 'Лингвини с жареными креветками' }
  };
  assert.equal(context.cmpConfirmSameName(row), true);
  assert.equal(row.edits.nameAccepted, true);
  assert.deepEqual(aliases, [{
    alias: 'Лингвини с жаренными креветками',
    target: 'Лингвини с жареными креветками'
  }]);
  // Не оставляем каталог в общем VM-контексте для следующих safety-тестов.
  delete context.PRODUCTS;
  delete context.addOrUpdateAlias;
});

test('OCR comparison treats slash and hyphen product-name variants as the same item', () => {
  assert.equal(
    context.cmpCanonicalName('Т Макарун фисташка/малина'),
    context.cmpCanonicalName('Т Макарун фисташка-малина')
  );
});

test('OCR safety rejects empty or invalid JSON', () => {
  assert.ok(context.getOCRSafetyIssues('', null, 2).some(x => x.code === 'empty-json'));
  assert.ok(context.getOCRSafetyIssues('{bad', null, 2).some(x => x.code === 'empty-json'));
});

test('OCR safety accepts an undated continuation page after a dated invoice', () => {
  const json = validJson({
    invoices: [
      {
        number: '123', date: '2026-10-06', continuation: false, last_line_number: 1,
        items: [{ line: 1, name: 'Товар A', quantity: 2, quantity_status: 'confirmed' }]
      },
      {
        number: '', date: '', continuation: true, last_line_number: 2,
        items: [{ line: 2, name: 'Товар B', quantity: 3, quantity_status: 'confirmed' }]
      }
    ]
  });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 2);
  assert.equal(issues.some(x => x.code === 'invoice-date-review'), false);
});

test('OCR safety still blocks a continuation page without any preceding invoice date', () => {
  const json = validJson({
    invoices: [{
      number: '', date: '', continuation: true, last_line_number: 1,
      items: [{ line: 1, name: 'Товар', quantity: 2, quantity_status: 'confirmed' }]
    }]
  });
  const issues = context.getOCRSafetyIssues(json, reportFor(json), 2);
  assert.equal(issues.some(x => x.code === 'invoice-date-review'), true);
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

  // Dates entered in Russian format must be normalized before the future-date
  // comparison; a lexical comparison of "08.10.2026" and "2026-10-07"
  // incorrectly lets the future audit date through.
  const futureRussianAudit = validJson({ check_date: '08.10.2026' });
  const futureRussianAuditCodes = context.getOCRSafetyIssues(futureRussianAudit, reportFor(futureRussianAudit), 2).map(x => x.code);
  assert.ok(futureRussianAuditCodes.includes('future-check-date'));

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
  assert.match(html, /const blockingSafetyIssues = otherSafetyIssues\.filter/);
  assert.match(html, /comparisonValid: quantityIssues\.length === 0 && blockingSafetyIssues\.length === 0/);
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

test('comparison application initializes catalog cards when no prior JSON import populated the table', () => {
  const applyStart = html.indexOf('function cmpApplyMatched()');
  const initPos = html.indexOf('getCategoryProducts(_activeCategory).forEach(product => {', applyStart);
  const applyPos = html.indexOf('let applied = 0;', applyStart);
  const tableLoopPos = html.indexOf('tableRows.forEach(row => {', applyPos);
  assert.ok(applyStart >= 0 && initPos > applyStart && applyPos > initPos && tableLoopPos > applyPos);
  assert.match(html.slice(initPos, applyPos), /stock: null/);
  assert.match(html.slice(initPos, applyPos), /shelfLife: product\.shelfLife/);
  assert.match(html.slice(initPos, applyPos), /incoming: \[\]/);
});

test('application version is consistent across runtime and visible UI', () => {
  assert.match(html, /const APP_VERSION = ['"]v9\.24\.29['"]/);
  assert.match(html, /id="moreAppVersion">v9\.24\.29</);
  assert.match(html, /id="aboutVersion">[^<]*v9\.24\.29</);
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


test('OCR comparison correction helper updates invoice and sales JSON, including confirmation status', () => {
  const source = JSON.stringify({
    invoices: [{
      date: '2026-10-06', continuation: false,
      items: [{ name: 'Пончик с фисташкой', quantity: 2, quantity_status: 'uncertain' }]
    }],
    sales: [{ name: 'Пончик с фисташкой', quantity: 1, quantity_status: 'uncertain' }],
    review: { handwritten_confirmation: ['Пончик с фисташкой'] }
  });
  const edits = [
    { name: context.cmpCanonicalName('Пончик с фисташкой'), dateKey: '06.10', quantity: 4, kind: 'incoming' },
    { name: context.cmpCanonicalName('Пончик с фисташкой'), quantity: 3, kind: 'sales' }
  ];
  const corrected = JSON.parse(context.cmpUpdateOCRJsonWithCorrections(source, edits));
  assert.equal(corrected.invoices[0].items[0].quantity, 4);
  assert.equal(corrected.invoices[0].items[0].quantity_status, 'confirmed');
  assert.equal(corrected.sales[0].quantity, 3);
  assert.equal(corrected.sales[0].quantity_status, 'confirmed');
  assert.deepEqual(corrected.review.handwritten_confirmation, []);
});

test('OCR comparison applies one confirmed choice to both differently named OCR variants', () => {
  const source = JSON.stringify({
    invoices: [
      { date: '2026-10-06', continuation: false,
        items: [{ name: 'Т Макарун фисташка-малина', quantity: 2, quantity_status: 'handwritten' }] },
      { date: '2026-10-06', continuation: false,
        items: [{ name: 'Т Макарун фисташка/малина', quantity: 3, quantity_status: 'uncertain' }] }
    ],
    sales: [
      { name: 'Т Макарун фисташка-малина', quantity: 1, quantity_status: 'confirmed' },
      { name: 'Т Макарун фисташка/малина', quantity: 4, quantity_status: 'confirmed' }
    ],
    review: { handwritten_confirmation: ['Т Макарун фисташка-малина'] }
  });
  const canonical = context.cmpCanonicalName('Т Макарун фисташка-малина');
  const variant = context.cmpCanonicalName('Т Макарун фисташка/малина');
  const edits = [
    { name: canonical, names: [canonical, variant], dateKey: '06.10', quantity: 5, kind: 'incoming' },
    { name: canonical, names: [canonical, variant], quantity: 6, kind: 'sales' }
  ];
  const corrected = JSON.parse(context.cmpUpdateOCRJsonWithCorrections(source, edits));
  assert.deepEqual(corrected.invoices.map(x => x.items[0].quantity), [5, 5]);
  assert.deepEqual(corrected.invoices.map(x => x.items[0].quantity_status), ['confirmed', 'confirmed']);
  assert.deepEqual(corrected.sales.map(x => x.quantity), [6, 6]);
  assert.deepEqual(corrected.sales.map(x => x.quantity_status), ['confirmed', 'confirmed']);
  assert.deepEqual(corrected.review.handwritten_confirmation, []);
});

test('comparison refresh removes stale discrepancy text after a quantity is selected', () => {
  assert.ok(html.includes("if (/^Приход не совпадает/.test(detail))"));
  assert.ok(html.includes("if (/^Продажи не совпадают/.test(detail))"));
  assert.match(html, /row\.details = \(row\.details \|\| \[\]\)\.filter/);
});

test('applying OCR comparison edits synchronizes corrected incoming and sales quantities to the JSON fields and both AI report sections', () => {
  const syncStart = html.indexOf('function cmpSyncAppliedCorrectionsToOCR()');
  const syncEnd = html.indexOf('function cmpApplyMatched()', syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart);
  const sync = html.slice(syncStart, syncEnd);
  assert.match(sync, /kind: 'incoming'/);
  assert.match(sync, /kind: 'sales'/);
  assert.ok(sync.includes('_lastGeminiJsons = { first, second }'));
  assert.ok(sync.includes('jsonInput.value = first'));
  assert.ok(sync.includes('report.invoiceJson = updateJson(report.invoiceJson)'));
  assert.ok(sync.includes('report.salesJson = updateJson(report.salesJson)'));
  assert.ok(sync.includes('report.salesReport = refreshedSales'));
  assert.ok(sync.includes('report.json = first'));
  assert.ok(sync.includes('report.fullRaw = first'));
  assert.ok(sync.includes('persistAIReport(report)'));
  const applyStart = html.indexOf('function cmpApplyMatched()');
  const syncCall = html.indexOf('cmpSyncAppliedCorrectionsToOCR();', applyStart);
  const renderCall = html.indexOf('renderTable();', applyStart);
  assert.ok(syncCall > applyStart && renderCall > syncCall, 'sync must run when comparison is applied');
});


test('catalog fallback uses canonical names when deduplicating OCR rows', () => {
  assert.match(html, /const alreadyKeys = new Set\(inCategory\.map\(r => cmpCanonicalName\(r\.name\)\)\);\s*const catProducts = getCategoryProducts\(_activeCategory\);\s*for \(const p of catProducts\) \{\s*const key = cmpCanonicalName\(p\.name\);/);
});
