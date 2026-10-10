import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('mobile WebKit viewport keeps card incoming edits after delayed refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('file://' + path.join(root, 'index.html'));

  const result = await page.evaluate(async () => {
    localStorage.clear();
    const target = {
      name: 'Товар с новым приходом', stock: 1, sales: 0, _originalSales: 0,
      shelfLife: 48, category: 'desserts', incoming: [], salesOnly: false,
      _checkDate: '2026-10-06'
    };
    const dateSource = {
      name: 'Товар с датой прихода', stock: 1, sales: 0, _originalSales: 0,
      shelfLife: 48, category: 'desserts',
      incoming: [{ date: '2026-10-06', qty: 3, _originalQty: 3 }],
      salesOnly: false, _checkDate: '2026-10-06'
    };
    tableRows = [target, dateSource];
    unknownRows = [];
    noCategoryRows = [];
    _needsCheckNames = new Set();
    renderCards();

    const cardsView = document.getElementById('cardsView');
    const display = getComputedStyle(cardsView).display;
    const card = [...document.querySelectorAll('#cardsView .card')]
      .find(el => el.textContent.includes(target.name));
    const inputs = card ? [...card.querySelectorAll('input.num')] : [];
    const incoming = inputs[inputs.length - 1];
    if (!incoming) throw new Error('mobile incoming input not found');
    incoming.focus();
    incoming.value = '1';
    incoming.dispatchEvent(new Event('input', { bubbles: true }));
    incoming.value = '12';
    incoming.dispatchEvent(new Event('input', { bubbles: true }));

    await new Promise(resolve => setTimeout(resolve, 300));
    const rowsAfterDelay = target.incoming.map(p => ({ date: p.date, qty: p.qty }));
    renderCards();
    const refreshedCard = [...document.querySelectorAll('#cardsView .card')]
      .find(el => el.textContent.includes(target.name));
    const refreshedInputs = refreshedCard ? [...refreshedCard.querySelectorAll('input.num')] : [];
    return {
      display,
      width: window.innerWidth,
      rowsAfterDelay,
      valueAfterRedraw: refreshedInputs[refreshedInputs.length - 1]?.value,
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
    };
  });

  expect(result.display).not.toBe('none');
  expect(result.width).toBe(390);
  expect(result.rowsAfterDelay).toEqual([{ date: '2026-10-06', qty: 12 }]);
  expect(result.valueAfterRedraw).toBe('12');
  expect(result.hasHorizontalOverflow).toBe(false);
});
