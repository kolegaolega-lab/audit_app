import fs from 'node:fs';
const html=fs.readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const names=[...html.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m=>m[1]);
const unique=[...new Set(names)];
if(unique.length < 300) throw new Error('Function inventory unexpectedly small: '+unique.length);
console.log('Function inventory: '+unique.length+' functions discovered.');
