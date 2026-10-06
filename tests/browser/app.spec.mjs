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

test('agreed 22:00 shelf-life cutoff and FIFO', async ({page}) => {
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
  expect(result.fifo).toEqual({soldExpired:0,expiredOnShelf:1,freshOnShelf:2,freshSold:0});
});
