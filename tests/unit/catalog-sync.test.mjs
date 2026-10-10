import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

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

test('silent point sync rejects duplicate IDs and normalized point numbers', () => {
  const start = html.indexOf('async function pullPointsSilently()');
  const end = html.indexOf('/* ═', start);
  assert.notEqual(start, -1, 'silent point sync must exist');
  assert.notEqual(end, -1, 'silent point sync must have a bounded source section');
  const source = html.slice(start, end);
  assert.match(source, /const seenIds = new Set\(\)/);
  assert.match(source, /const seenNums = new Set\(\)/);
  assert.match(source, /normalizeName\(num\)/);
  assert.match(source, /seenIds\.has\(id\) \|\| seenNums\.has\(numKey\)/);
  assert.match(source, /Array\.isArray\(p\)/, 'array-shaped records must be ignored');
});

test('adding a point uses the same normalized number comparison as remote sync', () => {
  const start = html.indexOf('function addPoint(');
  const end = html.indexOf('function removePoint(', start);
  assert.notEqual(start, -1, 'addPoint must exist');
  assert.notEqual(end, -1, 'addPoint source section must be bounded');
  const source = html.slice(start, end);
  assert.match(source, /const numKey = normalizeName\(n\)/);
  assert.match(source, /if \(!numKey\) return null/);
  assert.match(source, /_points\.some\(p => normalizeName\(p\.num\) === numKey\)/);
  assert.doesNotMatch(source, /p\.num\.toLowerCase\(\) === n\.toLowerCase\(\)/);
});

test('removing the active point updates the active-point UI and removes it from today route', () => {
  const start = html.indexOf('function removePoint(');
  const end = html.indexOf('function getPointById(', start);
  assert.notEqual(start, -1, 'removePoint must exist');
  assert.notEqual(end, -1, 'removePoint source must be bounded');
  const calls = [];
  const context = {
    _points: [{id:'p1',num:'001'}, {id:'p2',num:'002'}],
    _activePointId: 'p1',
    _route: {date:'2026-10-09',pointIds:['p1','p2']},
    POINTS_KEY: 'points',
    ACTIVE_POINT_KEY: 'active',
    localStorage: {
      values: new Map([['active','p1']]),
      setItem(key,value) { this.values.set(key,String(value)); },
      removeItem(key) { this.values.delete(key); }
    },
    savePoints() {},
    saveRoute() { calls.push('saveRoute'); },
    updatePointsCount() {},
    updateHeaderPoint() { calls.push('updateHeaderPoint'); },
    syncActivePointToInput() { calls.push('syncActivePointToInput'); },
    renderToday() { calls.push('renderToday'); }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.removePoint('p1');
  assert.deepEqual(Array.from(context._points, p => p.id), ['p2']);
  assert.equal(context._activePointId, 'p2');
  assert.equal(context.localStorage.values.get('active'), 'p2');
  assert.deepEqual(Array.from(context._route.pointIds), ['p2']);
  assert.ok(calls.includes('saveRoute'));
  assert.ok(calls.includes('updateHeaderPoint'));
  assert.ok(calls.includes('syncActivePointToInput'));
  assert.ok(calls.includes('renderToday'));
});

test('removing the last active point clears persisted selection and synchronizes UI', () => {
  const start = html.indexOf('function removePoint(');
  const end = html.indexOf('function getPointById(', start);
  const calls = [];
  const pointInput = {value:'001'};
  const context = {
    _points: [{id:'p1',num:'001'}],
    _activePointId: 'p1',
    _route: {date:'2026-10-09',pointIds:['p1']},
    ACTIVE_POINT_KEY: 'active',
    pointInput,
    $ (id) { return id === 'point' ? pointInput : null; },
    localStorage: {
      values: new Map([['active','p1']]),
      setItem(key,value) { this.values.set(key,String(value)); },
      removeItem(key) { this.values.delete(key); }
    },
    savePoints() {},
    saveRoute() {},
    updatePointsCount() {},
    updateHeaderPoint() { calls.push('updateHeaderPoint'); },
    syncActivePointToInput() { calls.push('syncActivePointToInput'); },
    renderToday() {}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.removePoint('p1');
  assert.equal(context._activePointId, null);
  assert.equal(context.localStorage.values.has('active'), false);
  assert.deepEqual(Array.from(context._route.pointIds), []);
  assert.ok(calls.includes('updateHeaderPoint'));
  assert.equal(context.pointInput.value, '');
  assert.equal(calls.includes('syncActivePointToInput'), false);
});

test('loading saved points removes duplicate normalized numbers and malformed records', () => {
  const start = html.indexOf('function loadPoints(');
  const end = html.indexOf('function savePoints(', start);
  assert.notEqual(start, -1, 'loadPoints must exist');
  assert.notEqual(end, -1, 'loadPoints source must be bounded');
  const context = {
    POINTS_KEY: 'points',
    localStorage: { getItem() { return JSON.stringify([
      {id:'p1',num:'001',name:'First'},
      {id:'p2',num:' 001 ',name:'Duplicate whitespace'},
      {id:'p3',num:'00-2',name:'Normalized duplicate'},
      {id:'p4',num:'00 2',name:'Normalized duplicate two'},
      ['array-shaped'],
      {id:'p5',num:'003',name:'Third'}
    ]); } },
    safeStr(value, max) { return typeof value === 'string' ? value.slice(0,max) : ''; },
    normalizeName(value) { return String(value || '').trim().toLowerCase().replace(/[-\\s]+/g,' '); }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.deepEqual(Array.from(context.loadPoints(), p => p.id), ['p1','p3','p5']);
});

test('history filenames are unique while the parser preserves point and login', () => {
  const buildStart = html.indexOf('function buildHistoryFilename(');
  const buildEnd = html.indexOf('function buildCheckSnapshot(', buildStart);
  const parseStart = html.indexOf('function parseHistoryFilename(');
  const parseEnd = html.indexOf('async function fetchHistoryMonthFolder(', parseStart);
  assert.notEqual(buildStart, -1);
  assert.notEqual(buildEnd, -1);
  assert.notEqual(parseStart, -1);
  assert.notEqual(parseEnd, -1);
  let tick = 1791540672000;
  let randomIndex = 0;
  class FixedDate extends Date {
    constructor() { super('2026-10-09T10:11:12Z'); }
    static now() { return tick++; }
  }
  const randomValues = [0.123456789, 0.987654321];
  const context = {
    Date: FixedDate,
    Math: { random() { return randomValues[randomIndex++ % randomValues.length]; } },
    HISTORY_DIR: 'history',
    getActivePoint() { return {id:'p1'}; },
    _profile: {login:'auditor',name:'Auditor'}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(buildStart, buildEnd), context);
  vm.runInContext(html.slice(parseStart, parseEnd), context);
  const firstPath = context.buildHistoryFilename();
  const secondPath = context.buildHistoryFilename();
  assert.notEqual(firstPath, secondPath, 'two checks in the same second must not share a file path');
  const firstName = firstPath.split('/').pop();
  const parsed = JSON.parse(JSON.stringify(context.parseHistoryFilename(firstName)));
  assert.equal(parsed.pointId, 'p1');
  assert.equal(parsed.login, 'auditor');
  assert.equal(parsed.day, 9);
  assert.match(parsed.timeHH, /^[0-9]{2}$/, 'time must remain parseable across local time zones');
  assert.equal(context.parseHistoryFilename('09-101112-p1-auditor.json').pointId, 'p1', 'legacy history filenames remain supported');
  assert.equal(context.parseHistoryFilename('99-991199-p1-auditor.json'), null, 'impossible dates and times are rejected');
});

test('history sending writes to the unique path and does not reuse a recent file by point alone', () => {
  const start = html.indexOf('async function sendReportToHistory(');
  const end = html.indexOf('async function pullPointsSilently(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = html.slice(start, end);
  assert.match(source, /await pushHistoryFile\(defaultPath, snapshot\)/);
  assert.doesNotMatch(source, /findRecentTwin/);
});

test('restoring a daily route removes duplicate and malformed point IDs', () => {
  const start = html.indexOf('function loadRoute(');
  const end = html.indexOf('function saveRoute(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = {
    ROUTE_KEY: 'route',
    localStorage: {
      getItem() { return JSON.stringify({date:'2026-10-09',pointIds:[
        'p1','p1',null,{},'','p2','p2', ...Array.from({length:25},(_,i)=>'p'+(i+3))
      ]}); }
    }
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  const route = JSON.parse(JSON.stringify(context.loadRoute()));
  assert.equal(route.date, '2026-10-09');
  assert.equal(route.pointIds.length, 20);
  assert.deepEqual(route.pointIds.slice(0,2), ['p1','p2']);
  assert.equal(new Set(route.pointIds).size, route.pointIds.length);
});

test('restoring a route rejects malformed dates and array-shaped envelopes', () => {
  const start = html.indexOf('function loadRoute(');
  const end = html.indexOf('function saveRoute(', start);
  const values = [
    JSON.stringify({date:'yesterday',pointIds:['p1']}),
    JSON.stringify([{date:'2026-10-09',pointIds:['p1']}]),
    JSON.stringify({date:'2026-10-09',pointIds:{}})
  ];
  const context = {
    ROUTE_KEY: 'route',
    localStorage: {getItem() { return values.shift(); }}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.equal(context.loadRoute(), null);
  assert.equal(context.loadRoute(), null);
  assert.equal(context.loadRoute(), null);
});

test('history cache ignores malformed months, entries and file records', () => {
  const start = html.indexOf('function loadHistoryCache(');
  const end = html.indexOf('const HISTORY_CACHE_MONTHS_MAX', start);
  const parseStart = html.indexOf('function parseHistoryFilename(');
  const parseEnd = html.indexOf('async function fetchHistoryMonthFolder(', parseStart);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.notEqual(parseStart, -1);
  assert.notEqual(parseEnd, -1);
  const validFile = {
    filename:'09-101112-p1~abc-auditor.json',day:30,timeHH:'22',timeMM:'33',timeSS:'44',
    pointId:'other-point',login:'wrong-user',sha:'abc',size:123
  };
  const stored = {
    '2026-10': {fetchedAt:900,files:[validFile,{filename:'bad.json',day:'9'},null,['array']]},
    '2026-09': {fetchedAt:2000,files:[validFile]},
    '2026-08': {fetchedAt:800,files:{}},
    '2026-13': {fetchedAt:800,files:[validFile]},
    malformed: {fetchedAt:800,files:[validFile]}
  };
  const context = {
    HISTORY_CACHE_KEY:'history-cache',
    HISTORY_CACHE_MONTHS_MAX:24,
    Date:{now(){return 1000;}},
    localStorage:{getItem(){return JSON.stringify(stored);}}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(parseStart,parseEnd),context);
  vm.runInContext(html.slice(start,end),context);
  const cache=JSON.parse(JSON.stringify(context.loadHistoryCache()));
  assert.deepEqual(Object.keys(cache),['2026-10']);
  assert.equal(cache['2026-10'].files.length,1);
  assert.equal(cache['2026-10'].files[0].pointId,'p1');
  assert.equal(cache['2026-10'].files[0].login,'auditor');
  assert.equal(cache['2026-10'].files[0].day,9);
  assert.equal(cache['2026-10'].files[0].timeHH,'10');
  assert.equal(cache['2026-10'].files[0].size,123);
});

test('history queue preserves duplicate-path snapshots under distinct parseable filenames', () => {
  const loadStart = html.indexOf('function loadHistoryQueue(');
  const loadEnd = html.indexOf('function saveHistoryQueue(', loadStart);
  const parseStart = html.indexOf('function parseHistoryFilename(');
  const parseEnd = html.indexOf('async function fetchHistoryMonthFolder(', parseStart);
  assert.notEqual(loadStart, -1);
  assert.notEqual(loadEnd, -1);
  assert.notEqual(parseStart, -1);
  assert.notEqual(parseEnd, -1);
  const legacyPath = 'history/2026-10/09-101112-p1-auditor.json';
  const stored = [
    {path:legacyPath,data:{date:'2026-10-09',pointId:'p1',marker:'first'},ts:1},
    {path:legacyPath,data:{date:'2026-10-09',pointId:'p1',marker:'second'},ts:2},
    {path:'../outside.json',data:{marker:'invalid'},ts:3},
    {path:'history/2026-10/bad.json',data:{marker:'invalid'},ts:4},
    {path:legacyPath,data:['not a snapshot'],ts:5}
  ];
  const context = {
    HISTORY_DIR:'history',
    HISTORY_QUEUE_KEY:'queue',
    localStorage:{getItem(){return JSON.stringify(stored);}}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(parseStart,parseEnd),context);
  vm.runInContext(html.slice(loadStart,loadEnd),context);
  const queue=JSON.parse(JSON.stringify(context.loadHistoryQueue()));
  assert.equal(queue.length,2);
  assert.notEqual(queue[0].path,queue[1].path);
  assert.deepEqual(queue.map(x=>x.data.marker),['first','second']);
  for (const entry of queue) {
    const parsed=context.parseHistoryFilename(entry.path.split('/').pop());
    assert.equal(parsed.pointId,'p1');
    assert.equal(parsed.login,'auditor');
  }
});

test('service worker activation deletes only stale caches owned by this app', async () => {
  const sw = fs.readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
  const handlers = {};
  const deleted = [];
  let claimed = 0;
  const context = {
    self: {
      addEventListener(type, handler) { handlers[type] = handler; },
      registration: { navigationPreload: { async disable() {} } },
      clients: { async claim() { claimed++; } },
      skipWaiting() {}
    },
    caches: {
      async keys() {
        return ['fb-audit-v87.64','fb-audit-runtime-v87.64','other-app-cache','fb-audit-v87.65','fb-audit-runtime-v87.65'];
      },
      async delete(name) { deleted.push(name); return true; }
    },
    console
  };
  vm.createContext(context);
  vm.runInContext(sw, context);
  let activation;
  handlers.activate({waitUntil(promise) { activation = promise; }});
  await activation;
  assert.deepEqual(deleted, ['fb-audit-v87.64','fb-audit-runtime-v87.64','fb-audit-v87.65','fb-audit-runtime-v87.65']);
  assert.equal(deleted.includes('other-app-cache'), false);
  assert.equal(claimed, 1);
});

test('remote and silent point sync reject numbers that normalize to empty', () => {
  const sections = [
    ['function validateRemoteCatalog(', 'function syncPullFromServer('],
    ['function syncPullFromServer(', 'function pullPointsSilently('],
    ['function pullPointsSilently(', 'const MONTH_NAMES_RU']
  ];
  for (const [startMarker,endMarker] of sections) {
    const start=html.indexOf(startMarker);
    const end=html.indexOf(endMarker,start+1);
    assert.notEqual(start,-1, startMarker+' must exist');
    assert.notEqual(end,-1, endMarker+' must bound source');
    const source=html.slice(start,end);
    assert.match(source,/!numKey/, startMarker+' must reject empty normalized numbers');
  }
});

test('history folder fetch rejects a successful but malformed API response', async () => {
  const start=html.indexOf('async function fetchHistoryMonthFolder(');
  const end=html.indexOf('async function fetchAndCacheMonth(',start);
  assert.notEqual(start,-1);
  assert.notEqual(end,-1);
  const context={
    GITHUB_API:'https://api.github.com',
    GITHUB_REPO:'owner/repo',
    HISTORY_DIR:'history',
    getSyncToken(){return 'token';},
    async fetchWithTimeout(){return {ok:true,status:200,async json(){return {message:'not a folder listing'};}};}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start,end),context);
  await assert.rejects(context.fetchHistoryMonthFolder('2026-10'),/Некорректный формат истории/);
});

test('history month cache with a non-array files field is refetched', async () => {
  const start=html.indexOf('async function fetchAndCacheMonth(');
  const end=html.indexOf('async function syncHistoryForCurrentMonth(',start);
  assert.notEqual(start,-1);
  assert.notEqual(end,-1);
  let fetched=0;
  const context={
    _historyCache:{'2026-10':{fetchedAt:1000,files:{bad:true}}},
    HISTORY_FETCH_COOLDOWN_MS:60000,
    Date:{now(){return 2000;}},
    async fetchHistoryMonthFolder(){fetched++;return [{type:'file',name:'09-101112-p1-auditor.json',sha:'abc',size:123}];},
    parseHistoryFilename(name){return {filename:name,day:9,timeHH:'10',timeMM:'11',timeSS:'12',pointId:'p1',login:'auditor'};},
    saveHistoryCache(){}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start,end),context);
  const files=JSON.parse(JSON.stringify(await context.fetchAndCacheMonth('2026-10')));
  assert.equal(fetched,1);
  assert.equal(files.length,1);
  assert.equal(files[0].pointId,'p1');
});

test('daily accumulator restore deduplicates dates and blocks malformed JSON without dropping the entry', () => {
  const start=html.indexOf('function loadDailyAccum(');
  const end=html.indexOf('function saveDailyAccum(',start);
  assert.notEqual(start,-1);
  assert.notEqual(end,-1);
  const valid = marker => ({
    iso:'2026-10-08',label:'08.10',ts:marker,
    json:JSON.stringify({invoices:[{marker}],sales:[]}),
    category:'desserts',blocked:false,needsCheck:false
  });
  const stored=[
    valid(1),valid(2),
    {iso:'2026-10-09',label:'09.10',ts:3,json:'{broken',category:'desserts'},
    {iso:'2026-02-30',label:'30.02',ts:4,json:JSON.stringify({invoices:[],sales:[]})},
    ['malformed']
  ];
  const context={
    DAILY_KEY:'daily',
    localStorage:{getItem(){return JSON.stringify(stored);}},
    safeDate(y,m,d){
      const date=new Date(y,m-1,d);
      return date.getFullYear()===y&&date.getMonth()===m-1&&date.getDate()===d
        ? String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0') : null;
    },
    safeStr(value,max){return String(value??'').slice(0,max);},
    isValidCategory(value){return value==='desserts';}
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start,end),context);
  const result=JSON.parse(JSON.stringify(context.loadDailyAccum()));
  assert.equal(result.length,2);
  assert.equal(JSON.parse(result[0].json).invoices[0].marker,2);
  assert.equal(result[1].iso,'2026-10-09');
  assert.equal(result[1].blocked,true);
  assert.equal(result[1].needsCheck,true);
});
