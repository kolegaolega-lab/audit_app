'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');

function extract(start, end) {
  const a = html.indexOf(start);
  assert.notEqual(a, -1, 'missing: ' + start);
  const b = html.indexOf(end, a);
  assert.notEqual(b, -1, 'missing: ' + end);
  return html.slice(a, b);
}

const context = {};
vm.createContext(context);
vm.runInContext(extract('function getOCRSafetyIssues(csvText, report, photoCount) {', 'function formatOCRSafetyMessage'), context);

test('OCR safety blocks empty or missing structured output', () => {
  assert.ok(context.getOCRSafetyIssues('', null, 1).some(x => x.code === 'empty-csv'));
  assert.ok(context.getOCRSafetyIssues('x', {hasBlocks:false}, 1).some(x => x.code === 'missing-ai-report'));
});

test('OCR safety blocks incomplete photo processing', () => {
  const report = {
    hasBlocks:true,
    completeness:{received:2, processed:1},
    unreadable:{isEmpty:true},
    handwrittenConfirmation:{isEmpty:true},
    blocks:{'СОМНИТЕЛЬНЫЕ_СТРОКИ':'пусто'}
  };
  assert.ok(context.getOCRSafetyIssues('x', report, 2).some(x => x.code === 'completeness-mismatch'));
});

test('OCR safety blocks unreadable and handwritten values', () => {
  const report = {
    hasBlocks:true,
    completeness:{received:1, processed:1},
    unreadable:{isEmpty:false, raw:'строка 4'},
    handwrittenConfirmation:{isEmpty:false, raw:'строка 7'},
    blocks:{'СОМНИТЕЛЬНЫЕ_СТРОКИ':'пусто'}
  };
  const codes = context.getOCRSafetyIssues('x', report, 1).map(x => x.code);
  assert.ok(codes.includes('unreadable'));
  assert.ok(codes.includes('handwritten-confirmation'));
});

test('OCR safety blocks missing and non-empty uncertainty block', () => {
  const base = {hasBlocks:true, completeness:{received:1,processed:1}, unreadable:{isEmpty:true}, handwrittenConfirmation:{isEmpty:true}};
  assert.ok(context.getOCRSafetyIssues('x', {...base, blocks:{}}, 1).some(x => x.code === 'review-block-missing'));
  assert.ok(context.getOCRSafetyIssues('x', {...base, blocks:{'СОМНИТЕЛЬНЫЕ_СТРОКИ':'К-во: 2 или 3'}}, 1).some(x => x.code === 'uncertain-rows'));
});

test('OCR safety propagates validation findings', () => {
  const report = {
    hasBlocks:true,
    completeness:{received:1,processed:1},
    unreadable:{isEmpty:true},
    handwrittenConfirmation:{isEmpty:true},
    blocks:{'СОМНИТЕЛЬНЫЕ_СТРОКИ':'пусто'},
    validation:{issues:[{level:'warn',title:'Проверка не пройдена'}]}
  };
  assert.ok(context.getOCRSafetyIssues('x', report, 1).some(x => x.code === 'validation-review'));
});

test('production source contains required OCR safety controls', () => {
  for (const marker of [
    '#РУКОПИСНОЕ_ПОДТВЕРЖДЕНИЕ',
    '#СОМНИТЕЛЬНЫЕ_СТРОКИ',
    'line-quantity-mismatch',
    'line-items-missing',
    'completeness-mismatch',
    'Не использовать рукописное количество автоматически'
  ]) {
    assert.ok(html.includes(marker), 'missing OCR safety marker: ' + marker);
  }
});
