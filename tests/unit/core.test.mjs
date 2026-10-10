import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html=(fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8').match(/<script[^>]*>[\s\S]*?<\/script>/gi)||[]).map(s=>s.replace(/^<script[^>]*>|<\/script>$/gi,'')).join('\n');

function extract(name){
  const startRe=new RegExp('function\\s+'+name+'\\s*\\([^)]*\\)\\s*\\{','m');
  const m=startRe.exec(html); assert.ok(m,'Function not found: '+name);
  const next=html.slice(m.index+m[0].length).search(/\nfunction\s+[A-Za-z_$][\w$]*\s*\(/);
  if(next<0) return html.slice(m.index);
  return html.slice(m.index,m.index+m[0].length+next);
}
function load(...names){
  const src="const MAX_NUM=100000; const SHELF_LIFE_START_HOUR=7; const WRITE_OFF_HOUR=22; const OriginalDate=globalThis.Date; function TestDate(...a){ return a.length?new OriginalDate(...a):new OriginalDate('2026-10-06T10:00:00'); } TestDate.prototype=OriginalDate.prototype; TestDate.now=()=>OriginalDate.parse('2026-10-06T10:00:00'); TestDate.parse=OriginalDate.parse; TestDate.UTC=OriginalDate.UTC; const Date=TestDate;\n"+names.map(extract).join('\n')+'\n';
  const box={};
  const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{},clear:()=>{},key:()=>null,length:0};
  const dollar=()=>null;
  const documentStub={querySelector:()=>null,getElementById:()=>null,addEventListener:()=>{}};
  const windowStub={localStorage:storage};
  new Function('box','localStorage','$','document','window',src+names.map(n=>'box.'+n+'='+n).join(';'))(box,storage,dollar,documentStub,windowStub);
  return box;
}

const f=load('clampNum','isValidDate','safeDate','onlyDigits','hoursToDays','daysToHours','normalizeName','cleanProductName','isServiceLine','normalizeForSearch','naturalCompare','parseDateRu','inferIsoFromDdmm','mergeIncomingByDate','getCheckMoment','getWriteOffMoment','emptyResult','computeFIFO','parseShelfLife');

test('numeric and date primitives',()=>{assert.equal(f.clampNum(12.5,0,10,0),10);assert.equal(f.clampNum('x',0,10,7),7);assert.equal(f.safeDate(2026,10,6),'2026-10-06');assert.equal(f.isValidDate(new Date(2026,9,6)),true);assert.equal(f.onlyDigits('a1-2b'),'12');});
test('shelf-life conversion',()=>{assert.equal(f.hoursToDays(48),2);assert.equal(f.daysToHours(3),72);assert.equal(f.parseShelfLife('48 ч'),48);assert.equal(f.parseShelfLife('2 дня'),48);});
test('catalog sanitizer preserves missing shelf life as null and rejects zero as a valid duration',()=>{
  const sanitizer=new Function('MAX_CATALOG','MAX_NAME','MAX_SHELF_HOURS','clampNum','normalizeName','isValidCategory',
    extract('sanitizeProducts')+'; return sanitizeProducts;')(
      5000,100,720,
      (v,min,max,fallback)=>Number.isFinite(Number(v))?Math.min(max,Math.max(min,Number(v))):fallback,
      v=>String(v||'').trim().toLowerCase().replace(/\s+/g,' '),
      c=>c==='desserts'||c==='lunches'||c==='pastry'
    );
  assert.equal(sanitizer([{name:'Без срока',shelfLife:null,category:null}])[0].shelfLife,null);
  assert.equal(sanitizer([{name:'Нулевой срок',shelfLife:0,category:null}])[0].shelfLife,null);
  assert.equal(sanitizer([{name:'Нормальный срок',shelfLife:48,category:null}])[0].shelfLife,48);
  assert.doesNotMatch(html,/if \(r\.shelfLife === 0\) shelf = 0/);
  const gateStart=html.indexOf('function getFinishCheckIssues()');
  const gateEnd=html.indexOf('function getFinishCheckBlockReason(',gateStart);
  const gate=html.slice(gateStart,gateEnd);
  assert.match(gate,/r\.shelfLife == null \|\| !Number\.isFinite\(Number\(r\.shelfLife\)\) \|\| Number\(r\.shelfLife\) <= 0/);
});
test('alias chains resolve stale OCR names to canonical products and price lookup normalizes spelling', () => {
  const products = [
    {name:'"Чизкейк Чёрная Смородина" пирожное'},
    {name:'Крем-суп тыквенный на кокосовом молоке'},
    {name:'Лингвини с жаренными креветками'}
  ];
  const aliases = [
    {alias:'Т "Чизкейк Чёрная смородина" Пирожное (НОВАЯ)',target:'"Чизкейк Чёрная смородина" Пирожное (НОВАЯ)'},
    {alias:'Чизкейк черная смородина',target:'"Чизкейк Чёрная смородина" Пирожное (НОВАЯ)'},
    {alias:'Чизкейк Чёрная смородина Пирожное (НОВАЯ)',target:'"Чизкейк Чёрная Смородина" пирожное'},
    {alias:'Крем суп тыквенный',target:'Т Крем-суп тыквенный на кокосовом молоке'},
    {alias:'Т Крем-суп тыквенный на кокосовом молоке',target:'Крем-суп тыквенный на кокосовом молоке'}
  ];
  const prices = {'Лингвини с жареными креветками':147.54};
  const priceIndex = new Map([['лингвини с жареными креветками',147.54]]);
  const source = [
    extract('normalizeName'), extract('cleanProductName'), extract('findAlias'),
    extract('applyAliases'), extract('cmpCanonicalName'), extract('getPriceFor')
  ].join('\\n') + '\\nreturn {applyAliases,getPriceFor};';
  const api = new Function('ALIASES','PRODUCTS','PRICES','_priceIndex',source)(
    aliases,products,prices,priceIndex
  );
  assert.equal(api.applyAliases('Чизкейк черная смородина'),products[0].name);
  assert.equal(api.applyAliases('Крем суп тыквенный'),products[1].name);
  assert.equal(api.getPriceFor('Лингвини с жаренными креветками'),147.54);
});

test('text normalization',()=>{assert.equal(f.normalizeName('  Пончик   Фисташка '),'пончик фисташка');assert.equal(f.normalizeForSearch('Ёлка'),'елка');assert.equal(f.cleanProductName('  Эклер  '),'Эклер');assert.equal(f.isServiceLine('Накладная №123'),true);assert.equal(f.isServiceLine('Пончик'),false);assert.ok(f.naturalCompare('Товар 2','Товар 10')<0);});
test('date parsing',()=>{const ref=new Date(2026,9,6);assert.equal(f.parseDateRu('27.09.2026',ref),'2026-09-27');assert.equal(f.parseDateRu('27.09',ref),'2026-09-27');assert.equal(f.inferIsoFromDdmm('05.10',ref),'2026-10-05');});
test('incoming merge',()=>{assert.deepEqual(f.mergeIncomingByDate([{date:'2026-10-07',qty:2},{date:'2026-10-06',qty:1},{date:'2026-10-07',qty:3}]),[{date:'2026-10-06',qty:1,_originalQty:1},{date:'2026-10-07',qty:5,_originalQty:2}]);});
test('22:00 cutoff 24/48/72/96',()=>{for(const [h,e] of [[24,'2026-10-06T22:00'],[48,'2026-10-07T22:00'],[72,'2026-10-08T22:00'],[96,'2026-10-09T22:00']])assert.equal(f.getWriteOffMoment('2026-10-06',h).toISOString().slice(0,16),e);});
test('non-24h shelf-life stays exact',()=>{assert.equal(f.getWriteOffMoment('2026-10-06',36).toISOString().slice(0,16),'2026-10-07T19:00');assert.equal(f.getWriteOffMoment('2026-10-06',60).toISOString().slice(0,16),'2026-10-08T19:00');});
test('22:00 boundary is strict: item is fresh before cutoff',()=>{const r={stock:1,sales:0,shelfLife:24,incoming:[{date:'2026-10-06',qty:1}],_checkDate:'2026-10-06'};const writeOff=f.getWriteOffMoment('2026-10-06',24);assert.equal(writeOff.getHours(),22);assert.equal(writeOff.getMinutes(),0);const calc=f.computeFIFO(r);assert.equal(calc.expiredOnShelf,0);assert.equal(calc.freshOnShelf,1);});
test('FIFO uses the original saved audit time after a later session restore',()=>{
  const checkedAfterCutoff=Date.parse('2026-10-06T22:01:00');
  const moment=f.getCheckMoment('2026-10-06',checkedAfterCutoff);
  assert.equal(moment.toISOString().slice(0,16),'2026-10-06T22:01');
  const calc=f.computeFIFO({stock:1,sales:0,shelfLife:24,incoming:[{date:'2026-10-06',qty:1}],_checkDate:'2026-10-06',_checkMoment:checkedAfterCutoff});
  assert.equal(calc.expiredOnShelf,1);
  assert.equal(calc.freshOnShelf,0);
});
test('session save and restore preserve the check moment used by FIFO',()=>{
  assert.match(html,/checkMoment:\s*\(\(\)\s*=>/);
  assert.match(html,/_checkMoment:\s*typeof data\.checkMoment === 'number'/);
  assert.match(html,/r\._checkMoment\s*=\s*checkMoment/);
});
test('Gemini model discovery and probes have bounded network waits',()=>{
  const probeStart=html.indexOf('async function testGeminiModel(');
  const discoverStart=html.indexOf('async function discoverGeminiModels(');
  const fillStart=html.indexOf('function fillModelSelect(',discoverStart);
  assert.ok(probeStart>=0 && discoverStart>probeStart && fillStart>discoverStart);
  const probe=html.slice(probeStart,discoverStart);
  const discovery=html.slice(discoverStart,fillStart);
  assert.match(probe,/fetchWithTimeout\(url,[\s\S]{0,180}15000\)/);
  assert.match(discovery,/const listRes = await fetchWithTimeout\(/);
  assert.match(discovery,/\}, 15000\)/);
  assert.doesNotMatch(discovery,/await fetch\(/);
});
test('photo storage read failures are surfaced instead of converted to an empty queue',()=>{
  const start=html.indexOf('async function getPhotos()');
  const end=html.indexOf('async function deletePhoto(',start);
  assert.ok(start>=0 && end>start);
  const source=html.slice(start,end);
  assert.match(source,/reject\(tx\.error\s*\|\|\s*req\.error/);
  assert.doesNotMatch(source,/catch\s*\([^)]*\)\s*\{\s*return\s*\[\]\s*;?\s*\}/);
  assert.match(html,/recognizeWithGemini: photo storage read failed/);
  assert.match(html,/recognizeDaily: photo storage read failed/);
  assert.match(html,/shareToAI: photo storage read failed/);
  assert.match(html,/renderPhotoQueue: unable to read photo storage/);
});
test('exact duplicate files are checked before every OCR/share path',()=>{
  assert.match(html,/async function findExactDuplicatePhotoFiles\(items\)/);
  assert.match(html,/const duplicatePhotos = await findExactDuplicatePhotoFiles\(items\)/);
  assert.match(html,/const duplicatePhotos = await findExactDuplicatePhotoFiles\(all\)/);
  assert.match(html,/Удалите дубликаты из списка и запустите распознавание снова/);
});
test('future-only incoming cannot make stock fresh',()=>{const r=f.computeFIFO({stock:2,sales:1,shelfLife:24,incoming:[{date:'2026-10-07',qty:5}],_checkDate:'2026-10-06'});assert.deepEqual(r,{soldExpired:1,expiredOnShelf:2,freshOnShelf:0,freshSold:0});});
test('FIFO 24h stock',()=>{assert.deepEqual(f.computeFIFO({stock:3,sales:0,shelfLife:24,incoming:[{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'}),{soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:0});});
test('FIFO oldest sales first',()=>{const r=f.computeFIFO({stock:0,sales:3,shelfLife:24,incoming:[{date:'2026-10-05',qty:2},{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'});assert.equal(r.soldExpired,2);assert.equal(r.freshSold,1);});
test('FIFO old and fresh stock',()=>{assert.deepEqual(f.computeFIFO({stock:3,sales:0,shelfLife:24,incoming:[{date:'2026-10-05',qty:1},{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'}),{soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:0});});
test('FIFO no incoming means expired',()=>{assert.deepEqual(f.computeFIFO({stock:2,sales:3,shelfLife:24,incoming:[],_checkDate:'2026-10-06'}),{soldExpired:3,expiredOnShelf:2,freshOnShelf:0,freshSold:0});});
test('FIFO salesOnly',()=>{assert.equal(f.computeFIFO({salesOnly:true,stock:99,sales:5,shelfLife:24,incoming:[]}).isSalesOnly,true);});
test('FIFO empty guards',()=>{assert.deepEqual(f.computeFIFO({stock:1,sales:1,shelfLife:0,incoming:[]}),f.emptyResult());assert.deepEqual(f.computeFIFO({stock:null,sales:1,shelfLife:24,incoming:[]}),f.emptyResult());});


test('mobile card edits immediately refresh the problem filter and counters',()=>{
  const start=html.indexOf('function refreshCardRow(');
  const end=html.indexOf('\n/* ═',start);
  assert.ok(start>=0 && end>start,'refreshCardRow must exist');
  const body=html.slice(start,end);
  assert.match(body,/updateSegmentedCounters\(\)/);
  assert.match(body,/applyTableFilter\(\)/);
  assert.match(body,/updateFinishCheckBtn\(\)/);
});


test('comparison corrections restore only for the exact same OCR documents',()=>{
  const start=html.indexOf('function cmpRestorePersistedEdits(');
  const end=html.indexOf('\nfunction cmpSaveEdit(',start);
  assert.ok(start>=0 && end>start,'cmpRestorePersistedEdits must exist');
  const body=html.slice(start,end);
  assert.match(body,/saved\.json1 === json1 && saved\.json2 === json2/);
  assert.match(body,/if \(!exactSource\)\s*\{\s*localStorage\.removeItem\(CMP_EDITS_KEY\);\s*return false;/);
  assert.ok(body.indexOf('if (!exactSource)') < body.indexOf('const byIdentity = new Map()'),'identity fallback must be guarded by exact source check');
});
test('fresh OCR recognition replaces comparison documents and clears saved quantity edits',()=>{
  const start=html.indexOf('_lastGeminiJsons = { first: a, second: b };',html.indexOf('async function recognizeWithGemini'));
  assert.ok(start>=0,'recognition result assignment must exist');
  const body=html.slice(start,start+650);
  assert.match(body,/\$\('cmpJson1'\)\)\s*\$\('cmpJson1'\)\.value = a/);
  assert.match(body,/\$\('cmpJson2'\)\)\s*\$\('cmpJson2'\)\.value = b \|\| ''/);
  assert.match(body,/localStorage\.removeItem\(CMP_EDITS_KEY\)/);
});
test('editing stock or sales in a mobile card does not mutate invoice arrivals',()=>{
  const start=html.indexOf('function renderCards(');
  const end=html.indexOf('function updateCardResults(',start);
  assert.ok(start>=0 && end>start,'renderCards must exist');
  const body=html.slice(start,end);
  assert.match(body,/onChange: v => \{ row\.stock =/);
  assert.match(body,/onChange: v => \{ row\.sales =/);
  assert.doesNotMatch(body,/onChange: v => \{[^}]*row\.incoming\s*=/s);
});
