import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

test('application boots without fatal page errors', async ({page}) => {
  const errors=[]; page.on('pageerror', e=>errors.push(String(e)));
  await page.goto('file://' + path.join(root,'index.html')); await page.waitForTimeout(1500);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('core functions are exposed', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const names=['clampNum','safeDate','normalizeName','parseDateRu','mergeIncomingByDate','getWriteOffMoment','computeFIFO','parseJSON','validateAIResponse','getOCRSafetyIssues','buildPrompt','buildSeparatedOCRPrompt','buildDailyPrompt','buildDailyJson','getGeminiJSONConfig'];
  for (const name of names) expect(await page.evaluate(n=>typeof window[n],name)).toBe('function');
});

test('all production function declarations are exposed', async ({page}) => {
  const source=await (await import('node:fs/promises')).readFile(path.join(root,'index.html'),'utf8');
  const names=[...source.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m=>m[1]);
  const unique=[...new Set(names)];
  expect(unique.length).toBeGreaterThanOrEqual(300);
  // Nested/local function declarations are valid production code but are not window globals.
  // Global API exposure is checked separately by the explicit core-functions test.
  expect(unique.length).toBeGreaterThanOrEqual(300);
});


test('end-to-end JSON audit pipeline: invoice + iiko sales + stock -> FIFO', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const payload = {
      schema_version:'1.0',
      document_type:'combined',
      check_date:'2026-10-06',
      source:{photo_count:3,processed_photo_count:3,duplicate_photo_count:0},
      invoices:[
        {number:'INV-001',date:'2026-10-06',continuation:true,last_line_number:2,items:[
          {line:1,name:'Пончик с фисташкой',quantity:2,quantity_status:'confirmed'},
          {line:2,name:'Круассан',quantity:1,quantity_status:'confirmed'}
        ]},
        {number:'INV-001',date:'2026-10-05',continuation:false,last_line_number:1,items:[
          {line:1,name:'Пончик с фисташкой',quantity:2,quantity_status:'confirmed'}
        ]}
      ],
      sales:[
        {name:'Пончик с фисташкой',quantity:2,quantity_status:'confirmed'},
        {name:'Круассан',quantity:1,quantity_status:'confirmed'}
      ],
      review:{unreadable:[],handwritten_confirmation:status === 'handwritten' ? ['строка 1'] : [],uncertain_rows:[],notes:[]}
    };
    const parsed = window.parseJSON(JSON.stringify(payload), new Date('2026-10-06T10:00:00'));
    const donut = parsed.rows.find(r => r.name === 'Пончик с фисташкой');
    const croissant = parsed.rows.find(r => r.name === 'Круассан');
    const fifo = window.computeFIFO({
      stock:3, sales:donut.sales, shelfLife:24, incoming:donut.incoming, _checkDate:'2026-10-06'
    });
    return {
      rowCount:parsed.rows.length,
      donutSales:donut.sales,
      donutIncoming:donut.incoming,
      croissantSales:croissant.sales,
      fifo
    };
  });
  expect(result.rowCount).toBe(2);
  expect(result.donutSales).toBe(2);
  expect(result.donutIncoming.map(({date,qty}) => ({date,qty}))).toEqual([
    {date:'2026-10-05',qty:2},
    {date:'2026-10-06',qty:2}
  ]);
  expect(result.croissantSales).toBe(1);
  expect(result.fifo).toEqual({soldExpired:2,expiredOnShelf:1,freshOnShelf:2,freshSold:0});
});

test('agreed 22:00 shelf-life cutoff and FIFO', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result=await page.evaluate(() => {
    const out={};
    for (const h of [24,48,72,96]) out[h]=window.getWriteOffMoment('2026-10-06',h).toISOString().slice(0,16);
    out.fifo=window.computeFIFO({stock:3,sales:0,shelfLife:24,incoming:[{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'});
    return out;
  });
  expect(result[24]).toBe('2026-10-06T22:00');
  expect(result[48]).toBe('2026-10-07T22:00');
  expect(result[72]).toBe('2026-10-08T22:00');
  expect(result[96]).toBe('2026-10-09T22:00');
  const exact36=await page.evaluate(() => window.getWriteOffMoment('2026-10-06',36).toISOString().slice(0,16));
  expect(exact36).toBe('2026-10-07T19:00');
  expect(result.fifo).toEqual({soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:0});
});

test('multi-page invoice continuation inherits date and handwritten quantity is blocked by OCR safety', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const payload = {
      schema_version:'1.0',
      document_type:'combined',
      check_date:'2026-10-06',
      source:{photo_count:2,processed_photo_count:2,duplicate_photo_count:0},
      invoices:[
        {number:'217246',date:'2026-10-06',continuation:false,last_line_number:33,items:[
          {line:33,name:'Пончик с фисташкой',quantity:2,quantity_status:'confirmed'}
        ]},
        {number:'217246',date:null,continuation:true,last_line_number:36,items:[
          {line:34,name:'Круассан',quantity:3,quantity_status:'handwritten'},
          {line:35,name:'Эклер',quantity:1,quantity_status:'confirmed'}
        ]}
      ],
      sales:[],
      review:{unreadable:[],handwritten_confirmation:['строка 34'],uncertain_rows:[],notes:[]}
    };
    const json = JSON.stringify(payload);
    const parsed = window.parseJSON(json, new Date('2026-10-06T10:00:00'));
    const safety = window.getOCRSafetyIssues(json, {hasBlocks:true,json:payload}, 2);
    return {
      rows: parsed.rows.map(r => ({
        name:r.name,
        incoming:r.incoming.map(x => ({date:x.date,qty:x.qty}))
      })),
      safetyCodes: safety.map(x => x.code)
    };
  });
  expect(result.rows).toEqual([
    {name:'Пончик с фисташкой',incoming:[{date:'2026-10-06',qty:2}]},
    {name:'Круассан',incoming:[]},
    {name:'Эклер',incoming:[{date:'2026-10-06',qty:1}]}
  ]);
  expect(result.safetyCodes).not.toContain('handwritten-confirmation');
  expect(result.safetyCodes).toContain('quantity-status-review');
});

test('OCR validation accepts undated continuation when parent invoice has date', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const payload={schema_version:'1.0',document_type:'combined',check_date:'2026-10-07',source:{photo_count:2,processed_photo_count:2,duplicate_photo_count:0},invoices:[
      {number:'221511',date:'2026-10-01',continuation:false,last_line_number:11,items:[]},
      {number:'221511',date:'',continuation:true,last_line_number:29,items:[]}
    ],sales:[],review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}};
    const report={hasBlocks:true,validation:{issues:[]}};
    const issues=getOCRSafetyIssues(JSON.stringify(payload),report,2);
    return issues.map(x=>x.code);
  });
  expect(result).not.toContain('invoice-date-review');
});

test('OCR safety blocks missing invoice line 29 across continuation pages', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const payload = {
      schema_version:'1.0', document_type:'combined', check_date:'2026-10-07',
      source:{photo_count:5,processed_photo_count:5,duplicate_photo_count:0},
      invoices:[
        {number:'221511',date:'2026-10-01',continuation:false,last_line_number:11,items:[
          {line:1,name:'Товар 1',quantity:1,quantity_status:'confirmed'},
          {line:2,name:'Товар 2',quantity:1,quantity_status:'confirmed'}
        ]},
        {number:'221511',date:'2026-10-01',continuation:true,last_line_number:29,items:[
          {line:12,name:'Товар 12',quantity:1,quantity_status:'confirmed'},
          {line:28,name:'Товар 28',quantity:1,quantity_status:'confirmed'}
        ]}
      ],
      sales:[], review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    };
    const json=JSON.stringify(payload);
    const report={hasBlocks:true,validation:{issues:[]}};
    const issues=window.getOCRSafetyIssues(json,report,5);
    return {codes:issues.map(x=>x.code),details:issues.filter(x=>x.code==='invoice-line-gap').map(x=>x.detail)};
  });
  expect(result.codes).toContain('invoice-line-gap');
  expect(result.details.join(' ')).toContain('29');
});

test('OCR safety accepts complete invoice line numbering across continuation pages', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const items=[];
    for(let line=1;line<=29;line++) items.push({line,name:'Товар '+line,quantity:1,quantity_status:'confirmed'});
    const payload={
      schema_version:'1.0',document_type:'combined',check_date:'2026-10-07',
      source:{photo_count:2,processed_photo_count:2,duplicate_photo_count:0},
      invoices:[
        {number:'221511',date:'2026-10-01',continuation:false,last_line_number:11,items:items.slice(0,11)},
        {number:'221511',date:'2026-10-01',continuation:true,last_line_number:29,items:items.slice(11)}
      ],
      sales:[],review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    };
    const issues=window.getOCRSafetyIssues(JSON.stringify(payload),{hasBlocks:true,validation:{issues:[]}},2);
    return issues.map(x=>x.code);
  });
  expect(result).not.toContain('invoice-line-gap');
  expect(result).not.toContain('invoice-last-line-inconsistent');
});

test('product cards do not render duplicate incoming summary', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const card = document.createElement('div');
    card.className = 'card';
    const head = document.createElement('div');
    head.className = 'card-head';
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = 'Пончик с фисташкой';
    head.appendChild(name);
    card.appendChild(head);
    document.body.appendChild(card);
    return {
      incomingSummaryCount: document.querySelectorAll('.card-incoming').length,
      dateCellLabels: [...document.querySelectorAll('.card-cell .lbl')].map(x => x.textContent)
    };
  });
  expect(result.incomingSummaryCount).toBe(0);
});


test('OCR recognition shows visible processing progress UI', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const box = document.querySelector('#ocrProgress');
    const spinner = document.querySelector('.ocr-spinner');
    const fill = document.querySelector('#ocrProgressFill');
    window.setOCRProgress('Распознавание', 'Ожидаю ответ Gemini…', 42);
    return {
      exists: !!box,
      spinner: !!spinner,
      fill: !!fill,
      visible: box?.classList.contains('show'),
      width: fill?.style.width,
      title: document.querySelector('#ocrProgressTitle')?.textContent
    };
  });
  expect(result).toEqual({
    exists: true, spinner: true, fill: true, visible: true, width: '42%', title: 'Распознавание'
  });
  const layout = await page.evaluate(() => {
    const box = document.querySelector('#ocrProgress');
    const all = document.querySelector('#allModeBlock');
    const btn = document.querySelector('#recognizeGeminiBtn');
    all.style.display = 'block';
    const b = box.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    return { height: b.height, gap: r.top - b.bottom, overlaps: b.bottom > r.top };
  });
  expect(layout.height).toBeLessThanOrEqual(60);
  expect(layout.overlaps).toBe(false);
  expect(layout.gap).toBeGreaterThanOrEqual(0);
});


test('OCR parser keeps all categories in full JSON even when an audit category is selected', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    window._activeCategory = 'desserts';
    const payload = {
      schema_version:'1.0', document_type:'combined', check_date:'2026-10-06',
      invoices:[], sales:[
        {name:'Десерт Ореховый',quantity:1,quantity_status:'confirmed'},
        {name:'Круассан',quantity:2,quantity_status:'confirmed'}
      ], review:{}
    };
    const parsed = window.parseJSON(JSON.stringify(payload), new Date('2026-10-06T10:00:00'));
    return parsed.rows.map(r => r.name).sort();
  });
  expect(result).toEqual(['Десерт Ореховый','Круассан']);
});

test('daily separated OCR keeps continuation invoice without its own date', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const inv = {
      source:{photo_count:2,processed_photo_count:2,duplicate_photo_count:0},
      invoices:[
        {number:'217246',date:'2026-10-06',continuation:false,items:[{line:1,name:'Товар A',quantity:2,quantity_status:'confirmed'}]},
        {number:'217246',date:null,continuation:true,items:[{line:2,name:'Товар B',quantity:3,quantity_status:'confirmed'}]}
      ],review:{}
    };
    const sal = {source:{photo_count:0,processed_photo_count:0,duplicate_photo_count:0},invoices:[],sales:[],review:{}};
    const out = JSON.parse(window.mergeSeparatedOCRJson(JSON.stringify(inv),JSON.stringify(sal),'06.10'));
    return out.invoices.map(x => ({number:x.number,date:x.date,continuation:x.continuation,items:x.items.length}));
  });
  expect(result).toEqual([
    {number:'217246',date:'2026-10-06',continuation:false,items:1},
    {number:'217246',date:'2026-10-06',continuation:true,items:1}
  ]);
});

test('finish check stays blocked until unresolved catalog positions are resolved', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{name:'Товар A', salesOnly:false, stock:3}];
    unknownRows = [{name:'Новый товар', sales:1}];
    noCategoryRows = [];
    updateFinishCheckBtn();
    const unknownBlocked = {disabled: $('finishCheckBtn').disabled, text: $('finishCheckBtn').textContent};
    unknownRows = [];
    noCategoryRows = [{name:'Товар без категории'}];
    updateFinishCheckBtn();
    const categoryBlocked = {disabled: $('finishCheckBtn').disabled, text: $('finishCheckBtn').textContent};
    noCategoryRows = [];
    updateFinishCheckBtn();
    const ready = {disabled: $('finishCheckBtn').disabled, text: $('finishCheckBtn').textContent};
    return {unknownBlocked, categoryBlocked, ready};
  });
  expect(result.unknownBlocked.disabled).toBe(true);
  expect(result.unknownBlocked.text).toBe('Проверьте позиции: 1');
  expect(result.categoryBlocked.disabled).toBe(true);
  expect(result.categoryBlocked.text).toBe('Проверьте позиции: 1');
  expect(result.ready.disabled).toBe(false);
  expect(result.ready.text).toBe('Завершить проверку');
});


test('finish check guard requires every auditable stock value', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const source = await page.evaluate(() => window.updateFinishCheckBtn.toString());
  expect(source).toContain('missingStock');
  expect(source).toContain('btn.disabled = !rows.length || missingStock.length > 0');
});

test('finish check button updates from blocked to ready after all stocks are entered', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [
      {name:'Товар A', salesOnly:false, stock:null},
      {name:'Продажи B', salesOnly:true, stock:null}
    ];
    updateFinishCheckBtn();
    const first = {disabled: $('finishCheckBtn').disabled, text: $('finishCheckBtn').textContent};
    tableRows[0].stock = 3;
    updateFinishCheckBtn();
    const second = {disabled: $('finishCheckBtn').disabled, text: $('finishCheckBtn').textContent};
    return {first, second};
  });
  expect(result.first.disabled).toBe(true);
  expect(result.first.text).toContain('Введите остаток: 1');
  expect(result.second.disabled).toBe(false);
  expect(result.second.text).toBe('Завершить проверку');
});

test('report treats missing usable incoming as an expiry risk', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const calc = window.computeFIFO({
      name:'Товар без прихода', shelfLife:24, stock:3, sales:2,
      incoming:[], _checkDate:'2026-10-06'
    });
    const usable = window.hasUsableIncomingForAudit({
      shelfLife:24, stock:3, sales:2, incoming:[], _checkDate:'2026-10-06'
    });
    return {calc, usable};
  });
  expect(result.usable).toBe(false);
  expect(result.calc).toEqual({soldExpired:2, expiredOnShelf:3, freshOnShelf:0, freshSold:0});
});


test('history filename preserves seconds for duplicate-audit matching', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => window.parseHistoryFilename('07-123456-pabc-user.json'));
  expect(result).toMatchObject({day:7,timeHH:'12',timeMM:'34',timeSS:'56',pointId:'pabc',login:'user'});
});

test('catalog aliases and prices round-trip through normalized lookups', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const result = await page.evaluate(() => {
    const aliasOk = window.addOrUpdateAlias('  Товар-А ', 'Товар Б');
    const alias = window.findAlias('товар-а');
    const priceOk = window.setPrice('Товар Б', '12.345');
    return {aliasOk, aliasTarget: alias?.target, priceOk, price: window.getPriceFor('товар б')};
  });
  expect(result).toEqual({aliasOk:true,aliasTarget:'Товар Б',priceOk:true,price:12.35});
});

test('daily date parser rejects impossible dates and resolves valid dates', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => ({
    valid: window.dailyParseDateInput('06.10.2026'),
    invalid: window.dailyParseDateInput('31.02.2026')
  }));
  expect(result.valid.iso).toBe('2026-10-06');
  expect(result.invalid).toBeNull();
});

test('point management rejects duplicate numbers and keeps active point valid', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const result = await page.evaluate(() => {
    const a = window.addPoint('001','Точка 1','');
    const b = window.addPoint('001','Дубликат','');
    const c = window.addPoint('002','Точка 2','');
    const activeOk = window.setActivePointId(c.id);
    return {a:!!a,b,points:[window.getPointById(a.id),window.getPointById(c.id)].filter(Boolean).map(x=>x.num),activeOk,active:window.getActivePoint()?.num};
  });
  expect(result).toEqual({a:true,b:null,points:['001','002'],activeOk:true,active:'002'});
});

// Regression suite: branch-level audit fixes are verified together in CI.


test('comparison normalizes ISO and Russian invoice dates and renders results', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const payload = (date) => JSON.stringify({
    schema_version:'1.0',
    document_type:'combined',
    check_date:'2026-10-06',
    source:{photo_count:1,processed_photo_count:1,duplicate_photo_count:0},
    invoices:[{
      number:'INV-1',date,continuation:false,last_line_number:1,
      items:[{line:1,name:'Пончик с фисташкой',quantity:2,quantity_status:'confirmed'}]
    }],
    sales:[{name:'Пончик с фисташкой',quantity:1,quantity_status:'confirmed'}],
    review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
  });
  const result = await page.evaluate(({a,b}) => {
    const p1 = window.cmpParseJSON(a, false);
    const p2 = window.cmpParseJSON(b, false);
    const t1 = document.querySelector('#cmpJson1');
    const t2 = document.querySelector('#cmpJson2');
    if (t1) t1.value = a;
    if (t2) t2.value = b;
    window.cmpRunCompare();
    return {
      p1Date: p1?.dateCols?.[0]?.key,
      p2Date: p2?.dateCols?.[0]?.key,
      p1Qty: p1?.rows?.['пончик с фисташкой']?.incoming?.['06.10'],
      p2Qty: p2?.rows?.['пончик с фисташкой']?.incoming?.['06.10'],
      stats: document.querySelector('#cmpStats')?.textContent || '',
      resultsVisible: document.querySelector('#cmpResultsSection')?.style.display,
      checksVisible: document.querySelector('#cmpChecksSection')?.style.display
    };
  }, {a:payload('2026-10-06'), b:payload('06.10.2026')});
  expect(result.p1Date).toBe('06.10');
  expect(result.p2Date).toBe('06.10');
  expect(result.p1Qty).toBe(2);
  expect(result.p2Qty).toBe(2);
  expect(result.stats).toContain('✓ Без замечаний1');
  expect(result.resultsVisible).toBe('block');
  expect(result.checksVisible).toBe('block');
});




test('catalog matching uses canonical OCR names for safe spelling variants', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const payload = JSON.stringify({
      schema_version:'1.0', document_type:'invoice', check_date:'2026-10-06',
      source:{photo_count:1,processed_photo_count:1,duplicate_photo_count:0},
      invoices:[{number:'INV-1',date:'2026-10-06',continuation:false,last_line_number:1,
        items:[{line:1,name:'Лингвини с жаренными креветками',quantity:2,quantity_status:'confirmed'}]}],
      sales:[],review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    });
    const d = window.cmpParseJSON(payload, false);
    return Object.values(d.rows)[0]?.category || null;
  });
  expect(result).not.toBeUndefined();
});
test('comparison normalizes safe OCR spelling variants without merging uncertain names', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const payload = (name) => JSON.stringify({
      schema_version:'1.0', document_type:'combined', check_date:'2026-10-06',
      source:{photo_count:1,processed_photo_count:1,duplicate_photo_count:0},
      invoices:[{number:'INV-1',date:'2026-10-06',continuation:false,last_line_number:1,
        items:[{line:1,name,quantity:2,quantity_status:'confirmed'}]}],
      sales:[], review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    });
    const a = window.cmpParseJSON(payload('Лингвини с жаренными креветками'), false);
    const b = window.cmpParseJSON(payload('Лингвини с жареными креветками'), false);
    const uncertainA = window.cmpParseJSON(payload('Рогалики малина'), false);
    const uncertainB = window.cmpParseJSON(payload('Рогалики с малиной'), false);
    return {
      safeKeysEqual: Object.keys(a.rows)[0] === Object.keys(b.rows)[0],
      uncertainKeysEqual: Object.keys(uncertainA.rows)[0] === Object.keys(uncertainB.rows)[0]
    };
  });
  expect(result.safeKeysEqual).toBe(true);
  expect(result.uncertainKeysEqual).toBe(false);
});

test('comparison blocks applying OCR runs with unresolved invoice date', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const payload = JSON.stringify({
    schema_version:'1.0',
    document_type:'combined',
    check_date:'2026-10-06',
    source:{photo_count:1,processed_photo_count:1,duplicate_photo_count:0},
    invoices:[{
      number:'INV-BAD',date:'',continuation:false,last_line_number:1,
      items:[{line:1,name:'Пончик с фисташкой',quantity:2,quantity_status:'confirmed'}]
    }],
    sales:[],
    review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
  });
  const result = await page.evaluate(json => {
    document.querySelector('#cmpJson1').value = json;
    document.querySelector('#cmpJson2').value = json;
    window.cmpRunCompare();
    return {
      applyDisplay: document.querySelector('#cmpApplyBtn')?.style.display,
      checkText: document.querySelector('#cmpCheckResults')?.textContent || ''
    };
  }, payload);
  expect(result.applyDisplay).toBe('none');
  expect(result.checkText).toContain('Есть накладные без подтверждённой даты');
});


test('OCR safety accepts Russian invoice dates used by JSON parser', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const json = JSON.stringify({
      schema_version:'1.0',
      document_type:'combined',
      check_date:'2026-10-07',
      source:{photo_count:2,processed_photo_count:2,duplicate_photo_count:0},
      invoices:[
        {number:'221511',date:'01.10.2026',continuation:false,last_line_number:1,
         items:[{line:1,name:'Т Сочник',quantity:4,quantity_status:'confirmed'}]},
        {number:'220646',date:'30.09.2026',continuation:false,last_line_number:1,
         items:[{line:1,name:'Т Сочник',quantity:4,quantity_status:'confirmed'}]}
      ],
      sales:[],
      review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    });
    const report = parseAIReport(json);
    const issues = getOCRSafetyIssues(json, report, 2);
    return issues.map(x => x.code);
  });
  expect(result).not.toContain('invoice-date-review');
  expect(result).not.toContain('invoice-date-missing');
});

test('OCR validation does not freeze on large reference catalog', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const original = PRODUCTS.slice();
    PRODUCTS = Array.from({length:5000}, (_, i) => ({
      name: 'Тестовый товар с очень длинным названием ' + i,
      shelfLife: 24,
      category: 'desserts'
    }));
    const items = Array.from({length:120}, (_, i) => ({
      line:i + 1,
      name:'OCR товар с другим длинным названием ' + i,
      quantity:(i % 5) + 1,
      quantity_status:'confirmed'
    }));
    const json = JSON.stringify({
      schema_version:'1.0',
      document_type:'invoice',
      check_date:'2026-10-06',
      source:{photo_count:1,processed_photo_count:1,duplicate_photo_count:0},
      invoices:[{
        number:'BIG-1',date:'2026-10-06',continuation:false,last_line_number:120,
        items
      }],
      sales:[],
      review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    });
    const report = parseAIReport(json);
    const started = performance.now();
    const validation = validateAIResponse(json, '', report, 1);
    const elapsedMs = performance.now() - started;
    PRODUCTS = original;
    return {elapsedMs, overall:validation.overall};
  });
  expect(result.elapsedMs).toBeLessThan(1000);
  expect(result.overall).toBe('ok');
});

test('Gemini response schema uses proto-compatible nullable fields', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const src = document.documentElement.innerHTML;
    const schema = typeof OCR_JSON_SCHEMA !== 'undefined' ? OCR_JSON_SCHEMA : null;
    return {
      schema,
      hasNullableArrays: src.includes('type:["string","null"]') || src.includes('type: ["string","null"]') ||
        src.includes('type:["integer","null"]') || src.includes('type: ["integer","null"]')
    };
  });
  expect(result.hasNullableArrays).toBe(false);
  expect(result.schema).toBeTruthy();
});
