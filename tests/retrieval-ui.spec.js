import {test, expect} from '@playwright/test';

const headers = {'X-Shengji-Token': 'ui-test-token'};

test('recording answer discloses selected ranges and opens the complete original', async ({page, request}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  expect((await request.post('/api/restore', {headers, data: {version: 2, records: []}})).ok()).toBeTruthy();
  const prefix = '前文。'.repeat(4600), quote = '最终预算是 28640 元。';
  const imported = await request.post('/api/import', {headers, data: {
    title: '问答阅读范围测试', text: prefix + quote, autoAnalyze: false,
  }});
  const {record} = await imported.json();
  await page.route('**/api/ask', route => route.fulfill({json: {
    items: [{text: '预算为 28640 元。', recordId: record.id, quote}],
    sources: [{id: record.id, title: record.title, characters: quote.length,
      totalCharacters: prefix.length + quote.length, truncated: true, selection: 'keywords',
      ranges: [{start: prefix.length, end: prefix.length + quote.length}]}],
    message: '基于本次纳入的原文生成；请点击来源核对。',
  }}));
  await page.goto('/');
  await page.locator('.sidebar [data-page="ask"]').click();
  await page.locator('#question-input').fill('最终预算多少？');
  await page.getByRole('button', {name: '检索并生成回答', exact: true}).click();
  await expect(page.locator('.answer-item blockquote')).toHaveText(quote);
  await expect(page.locator('#answer-results')).toContainText('未覆盖全文');
  await page.getByText('查看本次阅读范围', {exact: true}).click();
  await expect(page.locator('#answer-results details')).toContainText(`字符位置 ${prefix.length + 1}–${prefix.length + quote.length}`);
  await page.getByRole('button', {name: `来源：${record.title}`, exact: true}).click();
  await page.getByRole('button', {name: '转写原文', exact: true}).click();
  await expect(page.locator('.transcript')).toHaveText(prefix + quote);
  expect(errors).toEqual([]);
});
