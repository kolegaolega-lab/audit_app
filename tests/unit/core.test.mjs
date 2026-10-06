import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=(fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8').match(/<script[^>]*>[\s\S]*?<\/script>/gi)||[]).map(s=>s.replace(/^<script[^>]*>|<\/script>$/gi,'')).join('\n');

function extract(name){
  const re=new RegExp('function\\s+'+name+'\\s*\\([^)]*\\)\\s*\\{','m');
  const m=re.exec(html); assert.ok(m,'Function not found: '+name);
  let i=m.index+m[0].length,depth=1,quote=null,esc=false;
  for(;i<html.length&&depth;i++){
    const ch=html[i];
    if(quote){if(esc)esc=false;else if(ch==='\\\\')esc=true;else if(ch===quote)quote=null;continue;}
    if(ch==='"'||ch==="'"){quote=ch;continue;}
    if(ch==='{')depth++; else if(ch==='}')depth--;
  }
  return html.slice(m.index,i);
}
function load(...names){
  const src=names.map(extract).join('\n')+'\n';
  const box={};
  const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{},clear:()=>{},key:()=>null,length:0};
  const dollar=()=>null;
  new Function('box','localStorage','
const f=load('clampNum','isValidDate','safeDate','onlyDigits','hoursToDays','daysToHours','normalizeName','cleanProductName','isServiceLine','normalizeForSearch','naturalCompare','parseDateRu','inferIsoFromDdmm','mergeIncomingByDate','getCheckMoment','getWriteOffMoment','emptyResult','computeFIFO','parseShelfLife');

test('numeric and date primitives',()=>{assert.equal(f.clampNum(12.5,0,10,0),10);assert.equal(f.clampNum('x',0,10,7),7);assert.equal(f.safeDate(2026,10,6).getDate(),6);assert.equal(f.isValidDate(new Date(2026,9,6)),true);assert.equal(f.onlyDigits('a1-2b'),'12');});
test('shelf-life conversion',()=>{assert.equal(f.hoursToDays(48),2);assert.equal(f.daysToHours(3),72);assert.equal(f.parseShelfLife('48 ч'),48);assert.equal(f.parseShelfLife('2 дня'),48);});
test('text normalization',()=>{assert.equal(f.normalizeName('  Пончик   Фисташка '),'пончик фисташка');assert.equal(f.normalizeForSearch('Ёлка'),'елка');assert.equal(f.cleanProductName('  Эклер  '),'Эклер');assert.equal(f.isServiceLine('Доставка'),true);assert.equal(f.isServiceLine('Пончик'),false);assert.ok(f.naturalCompare('Товар 2','Товар 10')<0);});
test('date parsing',()=>{const ref=new Date(2026,9,6);assert.equal(f.parseDateRu('27.09.2026',ref),'2026-09-27');assert.equal(f.parseDateRu('27.09',ref),'2026-09-27');assert.equal(f.inferIsoFromDdmm('05.10',ref).toISOString().slice(0,10),'2026-10-05');});
test('incoming merge',()=>{assert.deepEqual(f.mergeIncomingByDate([{date:'2026-10-07',qty:2},{date:'2026-10-06',qty:1},{date:'2026-10-07',qty:3}]),[{date:'2026-10-06',qty:1,_originalQty:1},{date:'2026-10-07',qty:5,_originalQty:2}]);});
test('22:00 cutoff 24/48/72/96',()=>{for(const [h,e] of [[24,'2026-10-06T22:00'],[48,'2026-10-07T22:00'],[72,'2026-10-08T22:00'],[96,'2026-10-09T22:00']])assert.equal(f.getWriteOffMoment('2026-10-06',h).toISOString().slice(0,16),e);});
test('non-24h shelf-life stays exact',()=>{assert.equal(f.getWriteOffMoment('2026-10-06',36).toISOString().slice(0,16),'2026-10-07T19:00');assert.equal(f.getWriteOffMoment('2026-10-06',60).toISOString().slice(0,16),'2026-10-08T19:00');});
test('FIFO 24h stock',()=>{assert.deepEqual(f.computeFIFO({stock:3,sales:0,shelfLife:24,incoming:[{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'}),{soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:0});});
test('FIFO oldest sales first',()=>{const r=f.computeFIFO({stock:0,sales:3,shelfLife:48,incoming:[{date:'2026-10-05',qty:2},{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'});assert.equal(r.soldExpired,2);assert.equal(r.freshSold,1);});
test('FIFO old and fresh stock',()=>{assert.deepEqual(f.computeFIFO({stock:3,sales:0,shelfLife:48,incoming:[{date:'2026-10-05',qty:1},{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'}),{soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:0});});
test('FIFO no incoming',()=>{assert.deepEqual(f.computeFIFO({stock:2,sales:3,shelfLife:24,incoming:[],_checkDate:'2026-10-06'}),{soldExpired:3,expiredOnShelf:2,freshOnShelf:0,freshSold:0});});
test('FIFO salesOnly',()=>{assert.equal(f.computeFIFO({salesOnly:true,stock:99,sales:5,shelfLife:24,incoming:[]}).isSalesOnly,true);});
test('FIFO empty guards',()=>{assert.deepEqual(f.computeFIFO({stock:1,sales:1,shelfLife:0,incoming:[]}),f.emptyResult());assert.deepEqual(f.computeFIFO({stock:null,sales:1,shelfLife:24,incoming:[]}),f.emptyResult());});
,'document','window',src+names.map(n=>'box.'+n+'='+n).join(';'))(box,storage,dollar,{querySelector:()=>null,getElementById:()=>null,addEventListener:()=>{}},{localStorage:storage});
  return box;
}
const f=load('clampNum','isValidDate','safeDate','onlyDigits','hoursToDays','daysToHours','normalizeName','cleanProductName','isServiceLine','normalizeForSearch','naturalCompare','parseDateRu','inferIsoFromDdmm','mergeIncomingByDate','getCheckMoment','getWriteOffMoment','emptyResult','computeFIFO','parseShelfLife');

test('numeric and date primitives',()=>{assert.equal(f.clampNum(12.5,0,10,0),10);assert.equal(f.clampNum('x',0,10,7),7);assert.equal(f.safeDate(2026,10,6).getDate(),6);assert.equal(f.isValidDate(new Date(2026,9,6)),true);assert.equal(f.onlyDigits('a1-2b'),'12');});
test('shelf-life conversion',()=>{assert.equal(f.hoursToDays(48),2);assert.equal(f.daysToHours(3),72);assert.equal(f.parseShelfLife('48 ч'),48);assert.equal(f.parseShelfLife('2 дня'),48);});
test('text normalization',()=>{assert.equal(f.normalizeName('  Пончик   Фисташка '),'пончик фисташка');assert.equal(f.normalizeForSearch('Ёлка'),'елка');assert.equal(f.cleanProductName('  Эклер  '),'Эклер');assert.equal(f.isServiceLine('Доставка'),true);assert.equal(f.isServiceLine('Пончик'),false);assert.ok(f.naturalCompare('Товар 2','Товар 10')<0);});
test('date parsing',()=>{const ref=new Date(2026,9,6);assert.equal(f.parseDateRu('27.09.2026',ref),'2026-09-27');assert.equal(f.parseDateRu('27.09',ref),'2026-09-27');assert.equal(f.inferIsoFromDdmm('05.10',ref).toISOString().slice(0,10),'2026-10-05');});
test('incoming merge',()=>{assert.deepEqual(f.mergeIncomingByDate([{date:'2026-10-07',qty:2},{date:'2026-10-06',qty:1},{date:'2026-10-07',qty:3}]),[{date:'2026-10-06',qty:1,_originalQty:1},{date:'2026-10-07',qty:5,_originalQty:2}]);});
test('22:00 cutoff 24/48/72/96',()=>{for(const [h,e] of [[24,'2026-10-06T22:00'],[48,'2026-10-07T22:00'],[72,'2026-10-08T22:00'],[96,'2026-10-09T22:00']])assert.equal(f.getWriteOffMoment('2026-10-06',h).toISOString().slice(0,16),e);});
test('non-24h shelf-life stays exact',()=>{assert.equal(f.getWriteOffMoment('2026-10-06',36).toISOString().slice(0,16),'2026-10-07T19:00');assert.equal(f.getWriteOffMoment('2026-10-06',60).toISOString().slice(0,16),'2026-10-08T19:00');});
test('FIFO 24h stock',()=>{assert.deepEqual(f.computeFIFO({stock:3,sales:0,shelfLife:24,incoming:[{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'}),{soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:0});});
test('FIFO oldest sales first',()=>{const r=f.computeFIFO({stock:0,sales:3,shelfLife:48,incoming:[{date:'2026-10-05',qty:2},{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'});assert.equal(r.soldExpired,2);assert.equal(r.freshSold,1);});
test('FIFO old and fresh stock',()=>{assert.deepEqual(f.computeFIFO({stock:3,sales:0,shelfLife:48,incoming:[{date:'2026-10-05',qty:1},{date:'2026-10-06',qty:2}],_checkDate:'2026-10-06'}),{soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:0});});
test('FIFO no incoming',()=>{assert.deepEqual(f.computeFIFO({stock:2,sales:3,shelfLife:24,incoming:[],_checkDate:'2026-10-06'}),{soldExpired:3,expiredOnShelf:2,freshOnShelf:0,freshSold:0});});
test('FIFO salesOnly',()=>{assert.equal(f.computeFIFO({salesOnly:true,stock:99,sales:5,shelfLife:24,incoming:[]}).isSalesOnly,true);});
test('FIFO empty guards',()=>{assert.deepEqual(f.computeFIFO({stock:1,sales:1,shelfLife:0,incoming:[]}),f.emptyResult());assert.deepEqual(f.computeFIFO({stock:null,sales:1,shelfLife:24,incoming:[]}),f.emptyResult());});
