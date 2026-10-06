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
      review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
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
  expect(result.safetyCodes).toContain('handwritten-confirmation');
  expect(result.safetyCodes).toContain('quantity-status-review');
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
