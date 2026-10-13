import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL ?? 'http://localhost:4000';

const browser = await chromium.launch();
const page = await browser.newPage();

const calls = [];
page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith('/rpc/')) calls.push(`${request.method()} ${url.pathname}`);
});
const errors = [];
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
page.on('pageerror', (error) => errors.push(error.message));

const count = (call) => calls.filter((c) => c === call).length;
const text = (id) => page.getByTestId(id).innerText();

async function step(name, run) {
  await run();
  console.log(`ok - ${name}`);
}

try {
  await step('ssr renders data and hydration makes no duplicate reads', async () => {
    await page.goto(base);
    await page.waitForFunction(
      () => Number(document.querySelector('[data-testid=ticks]')?.textContent) > 0,
    );
    assert.equal(await text('planet'), 'Earth');
    assert.equal(await text('first'), 'Mercury');
    assert.deepEqual(await page.getByTestId('planets').locator('li').allInnerTexts(), [
      'Mercury',
      'Venus',
    ]);
    assert.equal(count('GET /rpc/planet/list'), 0);
    assert.equal(count('GET /rpc/planet/find'), 0);
  });

  await step('stream resource keeps receiving events', async () => {
    const first = Number(await text('ticks'));
    await page.waitForFunction(
      (n) => Number(document.querySelector('[data-testid=ticks]')?.textContent) > n,
      first,
    );
    assert.equal(count('GET /rpc/clock/ticks'), 1);
  });

  await step('infinite resource loads more pages', async () => {
    await page.getByTestId('load-more').click();
    await page.getByTestId('planets').locator('li').nth(3).waitFor();
    await page.getByTestId('load-more').click();
    await page.getByTestId('planets').locator('li').nth(4).waitFor();
    assert.equal(await page.getByTestId('load-more').count(), 0);
    assert.equal(count('GET /rpc/planet/list'), 2);
  });

  await step('resource reloads on input change, typed error narrows', async () => {
    await page.getByTestId('find-2').click();
    await page.getByTestId('planet').getByText('Venus').waitFor();
    await page.getByTestId('find-missing').click();
    await page.getByTestId('planet').getByText('NOT_FOUND 999').waitFor();
  });

  await step('mutation invalidates tags and tagged resources refetch', async () => {
    const listBefore = count('GET /rpc/planet/list');
    await page.getByTestId('name').fill('Pluto');
    await page.getByTestId('create').click();
    await page.getByTestId('create-status').getByText('success').waitFor();
    await page.getByTestId('planets').getByText('Pluto').waitFor();
    assert.equal(count('POST /rpc/planet/create'), 1);
    assert.equal(count('GET /rpc/planet/list'), listBefore + 1, 'all loaded rows in one request');
  });

  await step('tag cache serves a repeat read without a request', async () => {
    await page.getByTestId('find-2').click();
    await page.getByTestId('planet').getByText('Venus').waitFor();
    const finds = count('GET /rpc/planet/find');
    await page.getByTestId('find-missing').click();
    await page.getByTestId('planet').getByText('NOT_FOUND 999').waitFor();
    await page.getByTestId('find-2').click();
    await page.getByTestId('planet').getByText('Venus').waitFor();
    assert.equal(count('GET /rpc/planet/find'), finds + 1, 'only the uncached 404 is refetched');
  });

  await step('no console or hydration errors', async () => {
    const unexpected = errors.filter((e) => !e.includes('404') && !e.includes('NOT_FOUND'));
    assert.deepEqual(unexpected, []);
  });
} finally {
  console.log(calls.join('\n'));
  await browser.close();
}
