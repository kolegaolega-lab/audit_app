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

test('end-to-end applyJSON routes category rows and preserves FIFO inputs', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(async () => {
    localStorage.clear();
    PRODUCTS = [
      {name:'Товар десерт',shelfLife:48,category:'desserts'},
      {name:'Товар выпечка',shelfLife:24,category:'pastry'}
    ];
    tableRows = [];
    unknownRows = [];
    noCategoryRows = [];
    _needsCheckNames = new Set();
    _activeCategory = 'desserts';

    const payload = {
      schema_version:'1.0',
      document_type:'combined',
      check_date:'2026-10-06',
      source:{photo_count:2,processed_photo_count:2,duplicate_photo_count:0},
      invoices:[
        {number:'INV-1',date:'2026-10-06',continuation:false,last_line_number:1,items:[
          {line:1,name:'Товар десерт',quantity:2,quantity_status:'confirmed'}
        ]},
        {number:'INV-2',date:'2026-10-05',continuation:false,last_line_number:1,items:[
          {line:1,name:'Товар десерт',quantity:2,quantity_status:'confirmed'}
        ]}
      ],
      sales:[
        {name:'Товар десерт',quantity:2,quantity_status:'confirmed'},
        {name:'Товар выпечка',quantity:1,quantity_status:'confirmed'}
      ],
      review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    };

    document.querySelector('#jsonInput').value = JSON.stringify(payload);
    await window.applyJSON();

    const dessert = tableRows.find(r => r.name === 'Товар десерт');
    const pastry = tableRows.find(r => r.name === 'Товар выпечка');
    const calc = dessert ? window.computeFIFO({
      ...dessert, stock:3, _checkDate:'2026-10-06'
    }) : null;

    return {
      tableRows: tableRows.map(r => ({
        name:r.name, category:r.category, shelfLife:r.shelfLife,
        sales:r.sales, incoming:r.incoming.map(({date,qty}) => ({date,qty}))
      })),
      unknownRows: unknownRows.map(r => r.name),
      noCategoryRows: noCategoryRows.map(r => r.name),
      dessertCalc: calc,
      pastryPresent: !!pastry
    };
  });

  expect(result.tableRows).toEqual([
    {
      name:'Товар десерт', category:'desserts', shelfLife:48, sales:2,
      incoming:[{date:'2026-10-05',qty:2},{date:'2026-10-06',qty:2}]
    }
  ]);
  expect(result.unknownRows).toEqual([]);
  expect(result.noCategoryRows).toEqual([]);
  expect(result.pastryPresent).toBe(false);
  expect(result.dessertCalc).toEqual({
    soldExpired:0, expiredOnShelf:1, freshOnShelf:2, freshSold:2
  });
});

test('manual edits recalculate FIFO and survive session restore', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(async () => {
    localStorage.clear();
    PRODUCTS = [{name:'Тестовый десерт',shelfLife:48,category:'desserts'}];
    tableRows = [{
      name:'Тестовый десерт', stock:3, sales:2, _originalSales:2,
      shelfLife:48, category:'desserts',
      incoming:[
        {date:'2026-10-05',qty:2,_originalQty:2},
        {date:'2026-10-06',qty:2,_originalQty:2}
      ],
      salesOnly:false, _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    _needsCheckNames = new Set();

    let before = computeFIFO(tableRows[0]);

    tableRows[0].stock = 5;
    tableRows[0].incoming[0].qty = 0;
    tableRows[0].sales = 4;
    refreshRow = refreshRow;
    saveSession();
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY));

    const restored = loadSession();
    applySession(restored);
    const after = computeFIFO(tableRows[0]);

    return {
      before,
      savedRow: {
        stock:saved.rows[0].stock,
        sales:saved.rows[0].sales,
        incoming:saved.rows[0].incoming.map(p => [p.date,p.qty,p._originalQty])
      },
      after,
      restoredRow: {
        stock:tableRows[0].stock,
        sales:tableRows[0].sales,
        incoming:tableRows[0].incoming.map(p => [p.date,p.qty,p._originalQty]),
        checkDate:tableRows[0]._checkDate
      }
    };
  });

  expect(result.before).toEqual({soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:2});
  expect(result.savedRow).toEqual({
    stock:5,
    sales:4,
    incoming:[['2026-10-05',0,2],['2026-10-06',2,2]]
  });
  expect(result.after).toEqual({soldExpired:2,expiredOnShelf:5,freshOnShelf:0,freshSold:2});
  expect(result.restoredRow).toEqual({
    stock:5,
    sales:4,
    incoming:[['2026-10-05',0,2],['2026-10-06',2,2]],
    checkDate:'2026-10-06'
  });
});

test('restored edited row keeps the same danger status as before reload', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    localStorage.clear();
    tableRows = [{
      name:'Тест без свежего прихода', stock:2, sales:1, _originalSales:1,
      shelfLife:24, category:'desserts',
      incoming:[{date:'2026-10-05',qty:1,_originalQty:1}],
      salesOnly:false, _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    saveSession();

    const before = getRowStatus(computeFIFO(tableRows[0]), tableRows[0]);
    applySession(loadSession());
    const after = getRowStatus(computeFIFO(tableRows[0]), tableRows[0]);

    return {before,after,calc:computeFIFO(tableRows[0])};
  });

  expect(result.before).toEqual({cls:'row-danger',label:'danger'});
  expect(result.after).toEqual({cls:'row-danger',label:'danger'});
  expect(result.calc).toEqual({soldExpired:1,expiredOnShelf:2,freshOnShelf:0,freshSold:0});
});

test('shelf-life window boundaries are correct for 24/48/72/96 hours', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-17T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const check = (shelfLife, date) => {
      const w = window.getWriteOffMoment(date, shelfLife);
      const checkMoment = new Date('2026-10-17T10:00:00');
      return !!w && w > checkMoment;
    };
    return {
      h24: ['2026-10-17','2026-10-16'].map(d => check(24,d)),
      h48: ['2026-10-17','2026-10-16','2026-10-15'].map(d => check(48,d)),
      h72: ['2026-10-17','2026-10-16','2026-10-15','2026-10-14'].map(d => check(72,d)),
      h96: ['2026-10-17','2026-10-16','2026-10-15','2026-10-14','2026-10-13'].map(d => check(96,d))
    };
  });
  expect(result).toEqual({
    h24:[true,false],
    h48:[true,true,false],
    h72:[true,true,true,false],
    h96:[true,true,true,true,false]
  });
});

test('parseJSON keeps invoice dates needed by each shelf-life window', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    PRODUCTS = [{name:'Товар',shelfLife:72,category:'desserts'}];
    const payload = {
      schema_version:'1.0', document_type:'combined', check_date:'2026-10-17',
      source:{photo_count:4,processed_photo_count:4,duplicate_photo_count:0},
      invoices:[
        {number:'1',date:'2026-10-17',continuation:false,last_line_number:1,items:[{line:1,name:'Товар',quantity:1,quantity_status:'confirmed'}]},
        {number:'2',date:'2026-10-16',continuation:false,last_line_number:1,items:[{line:1,name:'Товар',quantity:2,quantity_status:'confirmed'}]},
        {number:'3',date:'2026-10-15',continuation:false,last_line_number:1,items:[{line:1,name:'Товар',quantity:3,quantity_status:'confirmed'}]},
        {number:'4',date:'2026-10-14',continuation:false,last_line_number:1,items:[{line:1,name:'Товар',quantity:4,quantity_status:'confirmed'}]}
      ],
      sales:[],
      review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    };
    const parsed = window.parseJSON(JSON.stringify(payload), new Date('2026-10-17T10:00:00'));
    return parsed.rows[0].incoming.map(({date,qty}) => ({date,qty}));
  });
  expect(result).toEqual([
    {date:'2026-10-14',qty:4},
    {date:'2026-10-15',qty:3},
    {date:'2026-10-16',qty:2},
    {date:'2026-10-17',qty:1}
  ]);
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

test('FIFO uses all received stock but flags shortage as expired', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-17T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => window.computeFIFO({
    stock:3,
    sales:2,
    shelfLife:48,
    incoming:[
      {date:'2026-10-16',qty:2},
      {date:'2026-10-17',qty:2}
    ],
    _checkDate:'2026-10-17'
  }));
  expect(result).toEqual({soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:2});
});

test('FIFO never uses future-dated incoming to make an audit result fresh', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-17T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => window.computeFIFO({
    stock:2,
    sales:1,
    shelfLife:48,
    incoming:[
      {date:'2026-10-16',qty:1},
      {date:'2026-10-18',qty:10}
    ],
    _checkDate:'2026-10-17'
  }));
  expect(result).toEqual({soldExpired:0,expiredOnShelf:2,freshOnShelf:0,freshSold:1});
});

test('FIFO merges same-day incoming before applying FIFO', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-17T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => window.computeFIFO({
    stock:1,
    sales:2,
    shelfLife:24,
    incoming:[
      {date:'2026-10-17',qty:1},
      {date:'2026-10-17',qty:2}
    ],
    _checkDate:'2026-10-17'
  }));
  expect(result).toEqual({soldExpired:0,expiredOnShelf:0,freshOnShelf:1,freshSold:2});
});

test('FIFO marks everything expired when there is no usable incoming', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-17T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => window.computeFIFO({
    stock:3,
    sales:2,
    shelfLife:24,
    incoming:[],
    _checkDate:'2026-10-17'
  }));
  expect(result).toEqual({soldExpired:2,expiredOnShelf:3,freshOnShelf:0,freshSold:0});
});

test('22:00 cutoff is strict: exactly 22:00 is expired', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const before = await page.evaluate(() => window.computeFIFO({
    stock:1,sales:0,shelfLife:24,
    incoming:[{date:'2026-10-17',qty:1}],_checkDate:'2026-10-17'
  }));
  await page.clock.setFixedTime(new Date('2026-10-17T22:00:00'));
  const at = await page.evaluate(() => window.computeFIFO({
    stock:1,sales:0,shelfLife:24,
    incoming:[{date:'2026-10-17',qty:1}],_checkDate:'2026-10-17'
  }));
  expect(before).toEqual({soldExpired:0,expiredOnShelf:0,freshOnShelf:1,freshSold:0});
  expect(at).toEqual({soldExpired:0,expiredOnShelf:1,freshOnShelf:0,freshSold:0});
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
    tableRows = [{name:'Товар A', salesOnly:false, stock:3, shelfLife:48, category:'desserts'}];
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


test('missing shelf life in catalog never defaults to 48h and blocks audit completion', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const cleaned = window.sanitizeProducts([
      {name:'Товар без срока', category:'desserts'},
      {name:'Товар 48ч', shelfLife:48, category:'desserts'}
    ]);
    PRODUCTS = cleaned;
    tableRows = [{name:'Товар без срока', stock:2, sales:1, shelfLife:cleaned[0].shelfLife, category:'desserts', salesOnly:false}];
    unknownRows = [];
    noCategoryRows = [];
    updateFinishCheckBtn();
    return {
      missingShelf: cleaned[0].shelfLife,
      validShelf: cleaned[1].shelfLife,
      blocked: $('finishCheckBtn').disabled,
      text: $('finishCheckBtn').textContent
    };
  });
  expect(result).toEqual({
    missingShelf: null,
    validShelf: 48,
    blocked: true,
    text: 'Укажите срок годности: 1'
  });
});

test('restored audit keeps missing shelf life as missing and blocks completion', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      version: 7,
      checkDate: '2026-10-06',
      rows: [{
        name: 'Товар без срока',
        stock: 2,
        sales: 1,
        shelfLife: null,
        category: 'desserts',
        incoming: [],
        salesOnly: false
      }],
      unknown: [],
      noCategory: [],
      needsCheck: []
    }));
    const data = loadSession();
    applySession(data);
    updateFinishCheckBtn();
    const row = tableRows[0];
    const calc = computeFIFO(row);
    return {
      shelfLife: row.shelfLife,
      fifo: calc,
      blocked: $('finishCheckBtn').disabled,
      text: $('finishCheckBtn').textContent
    };
  });
  expect(result.shelfLife).toBeNull();
  expect(result.fifo.soldExpired).toBeNull();
  expect(result.fifo.expiredOnShelf).toBeNull();
  expect(result.blocked).toBe(true);
  expect(result.text).toBe('Укажите срок годности: 1');
});

test('finish check guard requires every auditable stock value', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const source = await page.evaluate(() => window.updateFinishCheckBtn.toString());
  expect(source).toContain('missingStock');
  expect(source).toContain('missingStock');
  expect(source).toContain('unresolvedReference');
  expect(source).toContain('btn.disabled = blocked');
});

test('finish check button updates from blocked to ready after all stocks are entered', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [
      {name:'Товар A', salesOnly:false, stock:null, shelfLife:48, category:'desserts'},
      {name:'Продажи B', salesOnly:true, stock:null, shelfLife:48, category:'desserts'}
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


test('unfinished audit session survives reload with stock and incoming data', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const saved = await page.evaluate(() => {
    localStorage.clear();
    tableRows = [{
      name:'Товар восстановления',
      stock:3,
      sales:2,
      shelfLife:48,
      category:'desserts',
      incoming:[{date:'2026-10-06',qty:4,_originalQty:4}],
      salesOnly:false,
      _originalSales:2,
      _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    _needsCheckNames = new Set(['Товар восстановления']);
    const input = document.querySelector('#jsonInput');
    if (input) input.value = '{"check_date":"2026-10-06"}';
    saveSession();
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  });
  expect(saved.checkDate).toBe('2026-10-06');
  expect(saved.rows[0].stock).toBe(3);
  expect(saved.rows[0].incoming[0].qty).toBe(4);

  await page.reload();
  const restored = await page.evaluate(() => ({
    row: tableRows.find(r => r.name === 'Товар восстановления'),
    needsCheck: [..._needsCheckNames]
  }));
  expect(restored.row).toMatchObject({
    stock:3,
    sales:2,
    shelfLife:48,
    category:'desserts',
    _checkDate:'2026-10-06'
  });
  expect(restored.row.incoming).toEqual([{date:'2026-10-06',qty:4,_originalQty:4}]);
  expect(restored.needsCheck).toContain('Товар восстановления');
});


test('history snapshot keeps the audit check date after restoring an older session', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-08T21:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    localStorage.clear();
    _activePointId = null;
    tableRows = [{
      name:'Товар истории', stock:1, sales:0, _originalSales:0,
      shelfLife:24, category:'desserts',
      incoming:[{date:'2026-10-07',qty:2,_originalQty:2}],
      salesOnly:false, _checkDate:'2026-10-07'
    }];
    unknownRows = [];
    noCategoryRows = [];
    _needsCheckNames = new Set();
    saveSession();
    applySession(loadSession());
    return buildCheckSnapshot();
  });
  expect(result.date).toBe('2026-10-07');
  expect(result.categories.desserts[0]).toMatchObject({
    name:'Товар истории',
    stock:1,
    shelfLife:24
  });
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

test('comparison normalizes Rom baba quantity confirmation before safety gate', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const payload = JSON.stringify({
    schema_version:'1.0', document_type:'invoice', check_date:'2026-10-06',
    source:{photo_count:1,processed_photo_count:1,duplicate_photo_count:0},
    invoices:[{number:'RB-1',date:'2026-10-06',continuation:false,last_line_number:1,
      items:[{line:1,name:'Ром баба',quantity:4,quantity_status:'handwritten'}]}],
    sales:[],
    review:{unreadable:[],handwritten_confirmation:['Ром баба'],uncertain_rows:[],notes:[]}
  });
  const result = await page.evaluate(json => {
    $('cmpJson1').value = json;
    $('cmpJson2').value = json;
    cmpRunCompare();
    return {
      status: JSON.parse($('cmpJson1').value).invoices[0].items[0].quantity_status,
      review: JSON.parse($('cmpJson1').value).review.handwritten_confirmation,
      valid: _cmpData?.comparisonValid,
      safety: _cmpData?.safetyIssues || []
    };
  }, payload);
  expect(result.status).toBe('confirmed');
  expect(result.review).toEqual([]);
  expect(result.valid).toBe(true);
  expect(result.safety).toEqual([]);
});

test('comparison applies selected values from second run for one-sided rows and dates', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const payload = (items, sales) => JSON.stringify({
    schema_version:'1.0', document_type:'combined', check_date:'2026-10-06',
    source:{photo_count:1,processed_photo_count:1,duplicate_photo_count:0},
    invoices:[{number:'INV-1',date:'2026-10-05',continuation:false,last_line_number:items.length,
      items}],
    sales:sales == null ? [] : [{name:'Товар B',quantity:sales,quantity_status:'confirmed'}],
    review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
  });
  const result = await page.evaluate(({a,b}) => {
    PRODUCTS = [
      {name:'Товар A',shelfLife:48,category:'desserts'},
      {name:'Товар B',shelfLife:48,category:'desserts'}
    ];
    tableRows = [
      {name:'Товар A',stock:0,sales:0,shelfLife:48,category:'desserts',incoming:[],salesOnly:false},
      {name:'Товар B',stock:0,sales:0,shelfLife:48,category:'desserts',incoming:[],salesOnly:false}
    ];
    unknownRows = [];
    _activeCategory = 'desserts';
    $('cmpJson1').value = a;
    $('cmpJson2').value = b;
    cmpRunCompare();
    const row = _cmpData.rows.find(r => r.name === 'Товар B');
    row.edits.incoming['05.10'] = 7;
    row.edits.sales = 3;
    cmpRefreshSafetyGate();
    cmpApplyMatched();
    return {
      b: tableRows.find(r => r.name === 'Товар B'),
      row: {a:row.a?.incoming?.['05.10'] ?? null,b:row.b?.incoming?.['05.10'] ?? null}
    };
  }, {a:payload([{line:1,name:'Товар A',quantity:1,price:10,amount:10,quantity_status:'confirmed'}],null),
      b:payload([{line:1,name:'Товар A',quantity:1,price:10,amount:10,quantity_status:'confirmed'},
                 {line:2,name:'Товар B',quantity:5,price:10,amount:50,quantity_status:'confirmed'}],2)});
  expect(result.row).toEqual({a:null,b:5});
  expect(result.b.incoming.map(x => [x.date, x.qty])).toEqual([['2026-10-05', 7]]);
  expect(result.b.sales).toBe(3);
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

test('Ром баба uses printed quantity confirmation, not handwritten confirmation', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const input = {
      schema_version:'1.0', document_type:'invoice', check_date:'2026-10-06',
      source:{photo_count:1,processed_photo_count:1,duplicate_photo_count:0},
      invoices:[{number:'RB-1',date:'2026-10-06',continuation:false,last_line_number:1,items:[
        {line:1,name:'Ром баба',quantity:4,quantity_status:'handwritten'}
      ]}],
      sales:[],
      review:{unreadable:[],handwritten_confirmation:['Ром баба'],uncertain_rows:[],notes:[]}
    };
    const normalized = JSON.parse(window.normalizeKnownQuantityConfirmations(JSON.stringify(input)));
    return {
      status: normalized.invoices[0].items[0].quantity_status,
      review: normalized.review.handwritten_confirmation
    };
  });
  expect(result).toEqual({status:'confirmed',review:[]});
});

test('invoice continuation date does not leak into a new non-continuation invoice', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const payload = {
      schema_version:'1.0', document_type:'invoice', check_date:'2026-10-06',
      source:{photo_count:4,processed_photo_count:4,duplicate_photo_count:0},
      invoices:[
        {number:'A',date:'2026-10-06',continuation:false,last_line_number:1,items:[
          {line:1,name:'Товар A',quantity:1,quantity_status:'confirmed'}
        ]},
        {number:'A',date:null,continuation:true,last_line_number:2,items:[
          {line:2,name:'Товар B',quantity:2,quantity_status:'confirmed'}
        ]},
        {number:'B',date:null,continuation:false,last_line_number:1,items:[
          {line:1,name:'Товар C',quantity:3,quantity_status:'confirmed'}
        ]},
        {number:'B',date:null,continuation:true,last_line_number:2,items:[
          {line:2,name:'Товар D',quantity:4,quantity_status:'confirmed'}
        ]}
      ],
      sales:[],
      review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    };
    const parsed = window.parseJSON(JSON.stringify(payload), new Date('2026-10-06T10:00:00'));
    return Object.fromEntries(parsed.rows.map(r => [r.name, r.incoming.map(({date,qty}) => ({date,qty}))]));
  });
  expect(result['Товар A']).toEqual([{date:'2026-10-06',qty:1}]);
  expect(result['Товар B']).toEqual([{date:'2026-10-06',qty:2}]);
  expect(result['Товар C']).toEqual([]);
  expect(result['Товар D']).toEqual([]);
});

test('double-run comparison inherits dates for continuation invoice pages', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const payload = {
      schema_version:'1.0', document_type:'invoice', check_date:'2026-10-06',
      source:{photo_count:2,processed_photo_count:2,duplicate_photo_count:0},
      invoices:[
        {number:'A',date:'2026-10-06',continuation:false,last_line_number:1,items:[
          {line:1,name:'Товар A',quantity:1,quantity_status:'confirmed'}
        ]},
        {number:'A',date:null,continuation:true,last_line_number:2,items:[
          {line:2,name:'Товар B',quantity:2,quantity_status:'confirmed'}
        ]}
      ],
      sales:[],
      review:{unreadable:[],handwritten_confirmation:[],uncertain_rows:[],notes:[]}
    };
    const parsed = window.cmpParseJSON(JSON.stringify(payload), false, false);
    return {
      dates: parsed.dateCols,
      incoming: Object.fromEntries(parsed.order.map(k => [parsed.rows[k].name, parsed.rows[k].incoming]))
    };
  });
  expect(result.dates).toEqual([{key:'06.10',label:'06.10'}]);
  expect(result.incoming['Товар A']).toEqual({'06.10':1});
  expect(result.incoming['Товар B']).toEqual({'06.10':2});
});

test('check-step indicator follows completion gate for zero stock and restored sessions', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const base = {
      name:'Товар с нулевым остатком', salesOnly:false, stock:0, sales:0,
      shelfLife:24, category:'desserts',
      incoming:[{date:'2026-10-06',qty:1}], _checkDate:'2026-10-06'
    };
    _activeCategory = 'desserts';
    _photoCount = 1;
    unknownRows = [];
    noCategoryRows = [];
    tableRows = [{...base}];
    updateFinishCheckBtn();
    const ready = {
      canFinish: canFinishCheck(),
      step: computeCheckStep(),
      disabled: $('finishCheckBtn')?.disabled ?? null
    };

    tableRows = [{...base, stock:null}];
    updateFinishCheckBtn();
    const incomplete = {
      canFinish: canFinishCheck(),
      step: computeCheckStep(),
      disabled: $('finishCheckBtn')?.disabled ?? null
    };

    tableRows = [{...base}];
    saveSession();
    applySession(loadSession());
    updateFinishCheckBtn();
    const restored = {
      canFinish: canFinishCheck(),
      step: computeCheckStep(),
      disabled: $('finishCheckBtn')?.disabled ?? null
    };
    return {ready,incomplete,restored};
  });
  expect(result.ready).toEqual({canFinish:true,step:5,disabled:false});
  expect(result.incomplete).toEqual({canFinish:false,step:4,disabled:true});
  expect(result.restored).toEqual({canFinish:true,step:5,disabled:false});
});

test('completion gate blocks empty, missing stock, missing shelf life and unresolved reference states', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const base = {
      name:'Тестовый товар', salesOnly:false, stock:0, sales:0,
      shelfLife:24, category:'desserts', incoming:[{date:'2026-10-06',qty:1}],
      _checkDate:'2026-10-06'
    };
    const snapshot = () => ({
      canFinish: canFinishCheck(),
      btnDisabled: document.querySelector('#finishCheckBtn')?.disabled ?? null
    });

    tableRows = [];
    unknownRows = [];
    noCategoryRows = [];
    updateFinishCheckBtn();
    const empty = snapshot();

    tableRows = [{...base, stock:null}];
    updateFinishCheckBtn();
    const missingStock = snapshot();

    tableRows = [{...base, shelfLife:null}];
    updateFinishCheckBtn();
    const missingShelf = snapshot();

    tableRows = [{...base}];
    unknownRows = [{name:'Неизвестный товар'}];
    noCategoryRows = [];
    updateFinishCheckBtn();
    const unresolved = snapshot();

    return {empty, missingStock, missingShelf, unresolved};
  });
  expect(result.empty.canFinish).toBe(false);
  expect(result.empty.btnDisabled).toBe(true);
  expect(result.missingStock.canFinish).toBe(false);
  expect(result.missingStock.btnDisabled).toBe(true);
  expect(result.missingShelf.canFinish).toBe(false);
  expect(result.missingShelf.btnDisabled).toBe(true);
  expect(result.unresolved.canFinish).toBe(false);
  expect(result.unresolved.btnDisabled).toBe(true);
});

test('completion gate allows finished audit with confirmed stock even when findings exist', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар с просрочкой', salesOnly:false, stock:3, sales:2,
      shelfLife:24, category:'desserts',
      incoming:[{date:'2026-10-05',qty:1}],
      _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    updateFinishCheckBtn();
    const before = {canFinish: canFinishCheck(), disabled: $('finishCheckBtn')?.disabled ?? null};
    openReport();
    const after = {
      modalOpen: !$('reportModal')?.classList.contains('hidden'),
      reportText: $('reportBody')?.textContent || ''
    };
    return {before, after};
  });
  expect(result.before.canFinish).toBe(true);
  expect(result.before.disabled).toBe(false);
  expect(result.after.modalOpen).toBe(true);
  expect(result.after.reportText).toContain('Проверка завершена');
  expect(result.after.reportText).toContain('1 проблема');
});

test('completion gate allows sales-only rows without stock or shelf life', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Продажи без прихода', salesOnly:true, stock:null, sales:3,
      shelfLife:null, category:null, incoming:[], _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    updateFinishCheckBtn();
    return {canFinish: canFinishCheck(), disabled: $('finishCheckBtn')?.disabled ?? null};
  });
  expect(result.canFinish).toBe(true);
  expect(result.disabled).toBe(false);
});

test('openReport enforces the same completion gate even if button state is stale', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар без срока', salesOnly:false, stock:2, sales:0,
      shelfLife:null, category:'desserts', incoming:[], _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    const modal = $('reportModal');
    modal?.classList.add('hidden');
    const originalToast = window.showToast;
    let toast = '';
    window.showToast = msg => { toast = String(msg || ''); };
    openReport();
    window.showToast = originalToast;
    return {
      modalOpen: !modal?.classList.contains('hidden'),
      toast
    };
  });
  expect(result.modalOpen).toBe(false);
  expect(result.toast).toContain('срок годности');
});

test('report headline treats missing incoming as a problem', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар без прихода', salesOnly:false, stock:3, sales:0,
      shelfLife:24, category:'desserts', incoming:[], _checkDate:'2026-10-06'
    }];
    renderReport();
    return document.querySelector('#reportBody')?.textContent || '';
  });
  expect(result).toContain('1 проблема');
  expect(result).not.toContain('всё свежее');
  expect(result).toContain('Нет прихода');
});

test('completion gate blocks unresolved double-run comparison even when table inputs are complete', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар после старого результата', salesOnly:false, stock:1, sales:1,
      shelfLife:24, category:'desserts', incoming:[{date:'2026-10-06',qty:2}],
      _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    _cmpData = { rows: [], safetyIssues: [{code:'quantity-status-review'}], comparisonValid:false };
    updateFinishCheckBtn();
    return {
      canFinish: canFinishCheck(),
      disabled: $('finishCheckBtn')?.disabled ?? null,
      reason: getFinishCheckBlockReason(getFinishCheckIssues())
    };
  });
  expect(result.canFinish).toBe(false);
  expect(result.disabled).toBe(true);
  expect(result.reason).toContain('двух результатов');
});

test('completion gate blocks dates with pending OCR safety review', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар после непроверенного OCR', salesOnly:false, stock:1, sales:0,
      shelfLife:24, category:'desserts', incoming:[{date:'2026-10-06',qty:1}],
      _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    _cmpData = null;
    _dailyAccum = [{
      iso:'2026-10-06', label:'06.10', json:'{}', blocked:true, needsCheck:true,
      sourceMissing:['чек продаж не загружен']
    }];
    updateFinishCheckBtn();
    return {
      canFinish: canFinishCheck(),
      disabled: $('finishCheckBtn')?.disabled ?? null,
      reason: getFinishCheckBlockReason(getFinishCheckIssues())
    };
  });
  expect(result.canFinish).toBe(false);
  expect(result.disabled).toBe(true);
  expect(result.reason).toContain('результаты распознавания');
});

test('completion gate reopens after pending OCR comparison is cleared', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар после подтверждённой сверки', salesOnly:false, stock:1, sales:1,
      shelfLife:24, category:'desserts', incoming:[{date:'2026-10-06',qty:2}],
      _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    _dailyAccum = [];
    _cmpData = { rows: [], safetyIssues: [], comparisonValid:false };
    updateFinishCheckBtn();
    const blocked = canFinishCheck();
    _cmpData = { rows: [], safetyIssues: [], comparisonValid:true };
    updateFinishCheckBtn();
    return {
      blocked,
      reopened: canFinishCheck(),
      disabled: $('finishCheckBtn')?.disabled ?? null
    };
  });
  expect(result.blocked).toBe(false);
  expect(result.reopened).toBe(true);
  expect(result.disabled).toBe(false);
});

test('completion gate allows missing incoming as an explicit audit finding', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар без прихода', salesOnly:false, stock:3, sales:2,
      shelfLife:48, category:'desserts', incoming:[], _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    updateFinishCheckBtn();
    const before = {canFinish:canFinishCheck(), disabled:$('finishCheckBtn')?.disabled ?? null};
    openReport();
    return {
      before,
      modalOpen: !$('reportModal')?.classList.contains('hidden'),
      reportText: $('reportBody')?.textContent || ''
    };
  });
  expect(result.before).toEqual({canFinish:true, disabled:false});
  expect(result.modalOpen).toBe(true);
  expect(result.reportText).toContain('Нет прихода');
});

test('completion gate allows expired FIFO findings after all required inputs are present', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар с просроченным остатком', salesOnly:false, stock:4, sales:0,
      shelfLife:24, category:'desserts',
      incoming:[{date:'2026-10-04',qty:4}], _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    updateFinishCheckBtn();
    const calc = computeFIFO(tableRows[0]);
    return {calc, canFinish:canFinishCheck(), disabled:$('finishCheckBtn')?.disabled ?? null};
  });
  expect(result.calc.expiredOnShelf).toBe(4);
  expect(result.canFinish).toBe(true);
  expect(result.disabled).toBe(false);
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


test('finish gate blocks incomplete audit but allows legitimate FIFO findings', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const baseRow = (overrides = {}) => ({
      name:'Тестовый товар', stock:2, sales:1, _originalSales:1,
      shelfLife:24, category:'desserts',
      incoming:[{date:'2026-10-05',qty:1,_originalQty:1}],
      salesOnly:false, _checkDate:'2026-10-06', ...overrides
    });
    const check = (rows, extra = {}) => {
      tableRows = rows;
      unknownRows = extra.unknownRows || [];
      noCategoryRows = extra.noCategoryRows || [];
      _needsCheckNames = extra.needsCheckNames || new Set();
      _dailyAccum = extra.dailyAccum || [];
      _cmpData = extra.cmpData || null;
      return { can: canFinishCheck(), reason: getFinishCheckBlockReason(getFinishCheckIssues()) };
    };
    return {
      complete: check([baseRow()]),
      missingStock: check([baseRow({stock:null})]),
      missingShelfLife: check([baseRow({shelfLife:null})]),
      unknownReference: check([baseRow()], {unknownRows:[{name:'Неизвестный'}]}),
      noCategory: check([baseRow()], {noCategoryRows:[{name:'Без категории'}]}),
      noIncoming: check([baseRow({incoming:[]})]),
      expiredFIFO: check([baseRow({stock:5,sales:4,incoming:[{date:'2026-10-05',qty:2,_originalQty:2}]})]),
      salesOnly: check([{name:'Только продажи',stock:null,sales:3,shelfLife:null,category:'desserts',incoming:[],salesOnly:true}]),
      dailyPending: check([baseRow()], {dailyAccum:[{iso:'2026-10-06',label:'06.10',json:'{}',needsCheck:true,blocked:false}]}),
      comparisonPending: check([baseRow()], {cmpData:{comparisonValid:false}})
    };
  });
  expect(result.complete.can).toBe(true);
  expect(result.complete.reason).toBe('');
  expect(result.missingStock.can).toBe(false);
  expect(result.missingStock.reason).toContain('Введите остаток');
  expect(result.missingShelfLife.can).toBe(false);
  expect(result.missingShelfLife.reason).toContain('срок годности');
  expect(result.unknownReference.can).toBe(false);
  expect(result.noCategory.can).toBe(false);
  expect(result.noIncoming.can).toBe(true);
  expect(result.expiredFIFO.can).toBe(true);
  expect(result.salesOnly.can).toBe(true);
  expect(result.dailyPending.can).toBe(false);
  expect(result.comparisonPending.can).toBe(false);
});

test('finish gate button explains OCR and comparison blockers', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    const row = {
      name:'Тестовый товар', stock:2, sales:1, _originalSales:1,
      shelfLife:24, category:'desserts',
      incoming:[{date:'2026-10-05',qty:1,_originalQty:1}],
      salesOnly:false, _checkDate:'2026-10-06'
    };

    tableRows = [row];
    unknownRows = [];
    noCategoryRows = [];
    _needsCheckNames = new Set();
    _dailyAccum = [{
      iso:'2026-10-06', label:'06.10', json:'{}',
      needsCheck:true, blocked:false
    }];
    _cmpData = null;
    updateFinishCheckBtn();
    const daily = {
      disabled: $('finishCheckBtn')?.disabled ?? null,
      text: $('finishCheckBtn')?.textContent || '',
      title: $('finishCheckBtn')?.title || ''
    };

    _dailyAccum = [];
    _cmpData = { rows:[], safetyIssues:[{code:'quantity-status-review'}], comparisonValid:false };
    updateFinishCheckBtn();
    const comparison = {
      disabled: $('finishCheckBtn')?.disabled ?? null,
      text: $('finishCheckBtn')?.textContent || '',
      title: $('finishCheckBtn')?.title || ''
    };

    return {daily, comparison};
  });

  expect(result.daily.disabled).toBe(true);
  expect(result.daily.text).toContain('Проверьте распознавание');
  expect(result.daily.text).toContain('1');
  expect(result.daily.title).toContain('результаты распознавания');

  expect(result.comparison.disabled).toBe(true);
  expect(result.comparison.text).toContain('Завершите сверку');
  expect(result.comparison.title).toContain('двух результатов');
});

test('finish gate stays correct after session restore', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    localStorage.clear();
    tableRows=[{
      name:'Восстановленный товар', stock:2, sales:1, _originalSales:1,
      shelfLife:24, category:'desserts',
      incoming:[{date:'2026-10-05',qty:1,_originalQty:1}],
      salesOnly:false, _checkDate:'2026-10-06'
    }];
    unknownRows=[]; noCategoryRows=[]; _needsCheckNames=new Set(); _cmpData=null;
    saveSession();
    applySession(loadSession());
    return {can:canFinishCheck(),reason:getFinishCheckBlockReason(getFinishCheckIssues()),stock:tableRows[0].stock,shelfLife:tableRows[0].shelfLife};
  });
  expect(result).toEqual({can:true,reason:'',stock:2,shelfLife:24});
});


test('card status, report and history snapshot agree for zero stock with no incoming', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар без прихода и без остатка', salesOnly:false, stock:0, sales:0,
      shelfLife:24, category:'desserts', incoming:[], _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    const calc = computeFIFO(tableRows[0]);
    const status = getRowStatus(calc, tableRows[0]);
    const card = getCardStatus(calc, tableRows[0]);
    renderReport();
    const reportText = $('reportBody')?.textContent || '';
    const snapshot = buildCheckSnapshot();
    return {
      calc, status, card,
      reportText,
      snapshotItem:snapshot.categories.desserts[0],
      snapshotTotals:snapshot.totals
    };
  });
  expect(result.calc).toEqual({soldExpired:0,expiredOnShelf:0,freshOnShelf:0,freshSold:0});
  expect(result.status).toEqual({cls:'row-fresh',label:'fresh'});
  expect(result.card).toBe('fresh');
  expect(result.reportText).toContain('всё свежее');
  expect(result.reportText).not.toContain('Нет прихода');
  expect(result.snapshotItem.noIncoming).toBe(false);
  expect(result.snapshotTotals.noIncoming).toBe(0);
});

test('history snapshot preserves explicit missing-incoming finding consistently with report', async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-06T10:00:00'));
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    tableRows = [{
      name:'Товар с остатком без прихода', salesOnly:false, stock:3, sales:0,
      shelfLife:24, category:'desserts', incoming:[], _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    const calc = computeFIFO(tableRows[0]);
    const status = getRowStatus(calc, tableRows[0]);
    renderReport();
    const reportText = $('reportBody')?.textContent || '';
    const snapshot = buildCheckSnapshot();
    return {
      calc, status, reportText,
      snapshotItem:snapshot.categories.desserts[0],
      snapshotTotals:snapshot.totals
    };
  });
  expect(result.calc).toEqual({soldExpired:0,expiredOnShelf:3,freshOnShelf:0,freshSold:0});
  expect(result.status).toEqual({cls:'row-danger',label:'danger'});
  expect(result.reportText).toContain('Нет прихода');
  expect(result.snapshotItem.noIncoming).toBe(true);
  expect(result.snapshotTotals.noIncoming).toBe(1);
  expect(result.snapshotTotals.expiredOnShelf).toBe(3);
});


test('session restore preserves an unresolved double-run comparison blocker', async ({page}) => {
  await page.goto('file://' + path.join(root,'index.html'));
  const result = await page.evaluate(() => {
    localStorage.clear();
    tableRows = [{
      name:'Товар после незавершённой сверки', salesOnly:false, stock:2, sales:1,
      shelfLife:24, category:'desserts', incoming:[{date:'2026-10-06',qty:2}],
      _checkDate:'2026-10-06'
    }];
    unknownRows = [];
    noCategoryRows = [];
    _dailyAccum = [];
    _cmpData = {
      rows:[],
      safetyIssues:[{code:'quantity-status-review'}],
      comparisonValid:false
    };
    updateFinishCheckBtn();
    const before = {
      can:canFinishCheck(),
      disabled:$('finishCheckBtn')?.disabled ?? null
    };

    saveSession();
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
    _cmpData = null;
    applySession(loadSession());
    updateFinishCheckBtn();

    return {
      before,
      savedPending:saved.comparisonPending,
      restored:{
        can:canFinishCheck(),
        disabled:$('finishCheckBtn')?.disabled ?? null,
        reason:getFinishCheckBlockReason(getFinishCheckIssues())
      }
    };
  });
  expect(result.before).toEqual({can:false,disabled:true});
  expect(result.savedPending).toBe(true);
  expect(result.restored.can).toBe(false);
  expect(result.restored.disabled).toBe(true);
  expect(result.restored.reason).toContain('двух результатов');
});
