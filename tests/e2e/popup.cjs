const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
let failures = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'text/plain' });
    res.end(fs.readFileSync(f));
  }).listen(8765, '127.0.0.1');

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:8765/tests/popup-preview.html');
  await page.waitForSelector('.q-row', { timeout: 5000 });
  await sleep(400);

  // Answers tab renders its rows (was blank: list was appended to itself)
  await page.click('.tab[data-tab="answers"]');
  ok((await page.locator('#rows .answer-row').count()) === 4, 'Answers tab lists the 4 saved rows');

  // add row
  await page.click('#add');
  await sleep(150);
  ok((await page.locator('#rows .answer-row').count()) === 5, 'Add creates a visible new row');

  // edits persist
  await page.fill('#rows .answer-row:nth-child(2) textarea', 'changed@example.com');
  await sleep(500);
  const seeded = await page.evaluate(() => seed.entries.map((e) => e.value));
  ok(seeded.includes('changed@example.com'), 'editing an answer is written to storage');

  // delete row persists
  await page.click('#rows .answer-row:first-child .del-btn');
  await sleep(500);
  ok((await page.locator('#rows .answer-row').count()) === 4 && (await page.evaluate(() => seed.entries.length)) === 4, 'delete removes the row and persists');

  // detected questions: save a missing answer
  const missingBefore = await page.locator('.q-row--missing').count();
  await page.fill('.q-row--missing:has-text("Roll number") .q-input', '42');
  await page.click('.q-row--missing:has-text("Roll number") .btn-small');
  await sleep(500);
  const saved = await page.evaluate(() => seed.entries.find((e) => e.value === '42'));
  ok(!!saved && saved.keys[0] === '=Roll number', 'Save in the popup stores the answer (key ' + (saved && saved.keys[0]) + ')');
  ok((await page.locator('.q-row--missing').count()) === missingBefore - 1, 'saved question leaves the missing group');
  ok(await page.evaluate(() => [...document.querySelectorAll('#rows textarea')].some((t) => t.value === '42')), 'new answer also appears in the Answers tab');

  // dropdown question uses a select and saves the picked option
  await page.selectOption('.q-row--missing:has-text("Preferred branch") select', 'ECE');
  await page.click('.q-row--missing:has-text("Preferred branch") .btn-small');
  await sleep(400);
  ok(await page.evaluate(() => seed.entries.some((e) => e.value === 'ECE')), 'picked dropdown option is saved');

  // saved questions get a Fill button (was missing)
  ok((await page.locator('.q-row:has-text("Full name") .btn-ghost').count()) === 1, 'a saved question has its own Fill button');

  // fill all message
  await page.click('#fill');
  await sleep(500);
  ok(/Filled all 6 questions/.test(await page.textContent('#result')), 'fill message reads correctly');

  // settings
  await page.click('.tab[data-tab="settings"]');
  ok((await page.locator('#auto-open').count()) === 1, 'Settings has the auto-open switch');
  await page.evaluate(() => document.getElementById('auto-open').click());
  await sleep(300);
  ok((await page.evaluate(() => seed.settings.autoOpen)) === false, 'auto-open switch is saved');

  ok(errors.length === 0, 'no console or page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await page.screenshot({ path: '/tmp/shot-popup.png' });
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
