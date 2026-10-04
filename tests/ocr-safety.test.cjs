'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('index.html', 'utf8');
function extract(start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.notEqual(a, -1, 'start marker exists: ' + start);
  assert.notEqual(b, -1, 'end marker exists: ' + end);
  return html.slice(a, b);
}
function makeContext() {
  const context = {
    PRODUCTS: [],
    _activeCategory: null,
    cmpSplitLine(line, sep) { return line.split(sep).map(x => x.trim()); },
    cleanProductName(x) { return String(x || '').trim(); },
    isServiceLine() { return false; },
    applyAliases(x) { return x; },
    normalizeName(x) { return String(x || '').toLowerCase().replace(/\\s+/g, ' ').trim(); },
    isIgnored() { return false; },
    console
  };
  vm.createContext(context);
  vm.runInContext(extract('function cmpParseCSV(text) {', 'function cmpCalcSigmaForDate'), context);
  vm.runInContext(extract('function getOCRSafetyIssues(csvText, report, photoCount) {', 'function formatOCRSafetyMessage'), context);
  return context;
}

test('identical OCR product rows are treated as duplicate, not added', () => {
  const c = makeContext();
  const parsed = c.cmpParseCSV('Наименование;Продано сегодня;Получено за 04.10\\nКруассан;0;2\\nКруассан;0;2');
  assert.equal(parsed.count, 1);
  assert.equal(parsed.rows['круассан'].incoming['04.10'], 2);
});

test('conflicting duplicate product quantities stop OCR merge', () => {
  const c = makeContext();
  assert.throws(
    () => c.cmpParseCSV('Наименование;Продано сегодня;Получено за 04.10\\nКруассан;0;2\\nКруассан;0;3'),
    /разные количества|ручную сверку/i
  );
});

test('OCR safety blocks when processed image count is missing or incomplete', () => {
  const c = makeContext();
  const base = { hasBlocks: true, blocks: { 'СОМНИТЕЛЬНЫЕ_СТРОКИ': 'пусто' }, unreadable: { isEmpty: true }, handwrittenConfirmation: { isEmpty: true } };
  assert.ok(c.getOCRSafetyIssues('Наименование;Продано сегодня\\nКруассан;1', base, 2).some(x => x.code === 'completeness-mismatch'));
  base.completeness = { received: 2, processed: 1 };
  assert.ok(c.getOCRSafetyIssues('Наименование;Продано сегодня\\nКруассан;1', base, 2).some(x => x.code === 'completeness-mismatch'));
});

test('OCR safety blocks when uncertainty block is absent or non-empty', () => {
  const c = makeContext();
  const base = { hasBlocks: true, completeness: { received: 1, processed: 1 }, blocks: {}, unreadable: { isEmpty: true }, handwrittenConfirmation: { isEmpty: true } };
  assert.ok(c.getOCRSafetyIssues('ok', base, 1).some(x => x.code === 'review-block-missing'));
  base.blocks['СОМНИТЕЛЬНЫЕ_СТРОКИ'] = 'К-во: 2 или 3';
  assert.ok(c.getOCRSafetyIssues('ok', base, 1).some(x => x.code === 'uncertain-rows'));
});

test('any client-side validation finding blocks automatic OCR application', () => {
  const c = makeContext();
  const base = { hasBlocks: true, completeness: { received: 1, processed: 1 }, blocks: { 'СОМНИТЕЛЬНЫЕ_СТРОКИ': 'пусто' }, unreadable: { isEmpty: true }, handwrittenConfirmation: { isEmpty: true }, validation: { overall: 'warn', issues: [{ level: 'warn', title: 'Возможная опечатка' }] } };
  assert.ok(c.getOCRSafetyIssues('ok', base, 1).some(x => x.code === 'validation-review'));
});
