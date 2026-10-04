const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const EXT = path.resolve(__dirname, '../..');
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-form.html'), 'utf8');
const URL = 'https://docs.google.com/forms/d/e/TESTFORM/viewform';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STUB = `
  (() => {
    const listeners = [];
    window.__fire = (changes) => listeners.forEach((fn) => fn(changes, 'local'));
    window.chrome = {
      runtime: { id: 'test-ext', onMessage: { addListener: (fn) => { window.__msgHandler = fn; } } },
      storage: {
        local: {
          get: (key) => window.__storeGet(key),
          set: (obj) => window.__storeSet(obj),
        },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
    };
  })();
`;

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route('https://docs.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: MOCK }));

  // chrome.storage.local lives in node so it survives page reloads
  let store = {};
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  let pageRef = null;
  await ctx.exposeFunction('__storeGet', (key) => {
    const keys = typeof key === 'string' ? [key] : key;
    const out = {};
    keys.forEach((k) => { if (k in store) out[k] = clone(store[k]); });
    return out;
  });
  await ctx.exposeFunction('__storeSet', async (obj) => {
    const changes = {};
    for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[k], newValue: clone(v) }; store[k] = clone(v); }
    if (pageRef) await pageRef.evaluate((c) => window.__fire && window.__fire(c), changes).catch(() => {});
  });
  await ctx.addInitScript(STUB);

  const setStore = async (obj) => {
    const changes = {};
    for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[k], newValue: clone(v) }; store[k] = clone(v); }
    if (pageRef) await pageRef.evaluate((c) => window.__fire(c), changes);
  };
  const getStore = async (k) => ({ [k]: clone(store[k]) });
  const clearStore = async () => { store = {}; };
  const inject = async (page) => {
    await page.addScriptTag({ path: path.join(EXT, 'lib/matcher.js') });
    await page.addScriptTag({ path: path.join(EXT, 'content.js') });
  };
  const send = (page, msg) => page.evaluate((m) => new Promise((res) => {
    const r = window.__msgHandler(m, {}, res);
    if (r !== true) res(undefined);
  }), msg);

  const page = await ctx.newPage();
  pageRef = page;
  const origGoto = page.goto.bind(page);
  page.goto = async (u) => { const r = await origGoto(u); await inject(page); return r; };
  const origReload = page.reload.bind(page);
  page.reload = async () => { const r = await origReload(); await inject(page); return r; };
  page.on('console', (m) => { if (/FormFlash|Error/i.test(m.text())) console.log('  [page]', m.text()); });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  const panel = (sel) => page.locator('#formflash-host ' + sel);
  const cardVisible = () => page.evaluate(() => {
    const h = document.getElementById('formflash-host');
    const c = h && h.shadowRoot.querySelector('.card');
    return !!c && !c.hidden;
  });
  const tabVisible = () => page.evaluate(() => {
    const h = document.getElementById('formflash-host');
    const t = h && h.shadowRoot.querySelector('.tab');
    return !!t && !t.hidden;
  });
  const pendingLabels = () => page.evaluate(() => {
    const h = document.getElementById('formflash-host');
    return [...h.shadowRoot.querySelectorAll('.list .q-label')].map((n) => n.textContent);
  });
  const sh = (fn, arg) => page.evaluate(({ fnStr, arg }) => {
    const h = document.getElementById('formflash-host');
    return new Function('root', 'arg', fnStr)(h.shadowRoot, arg);
  }, { fnStr: fn, arg });

  // ---- A: fresh profile, nothing saved -> panel opens by itself
  await clearStore();
  await page.goto(URL);
  await page.waitForSelector('#formflash-host', { state: 'attached', timeout: 8000 }).catch(() => {});
  await sleep(1500);
  ok(await page.locator('#formflash-host').count() === 1, 'A: panel host injected on the form page');
  ok(await cardVisible(), 'A: panel opened automatically with no saved answers');
  const labels = await pendingLabels();
  ok(labels.length === 7, 'A: all 7 questions listed as missing (got ' + labels.length + ': ' + labels.join(' | ') + ')');

  // geometry: docked to right edge, vertically centred
  const box = await page.evaluate(() => {
    const r = document.getElementById('formflash-host').getBoundingClientRect();
    return { right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
  });
  ok(Math.abs(box.right - box.vw) <= 1, 'A: panel flush with the right edge (right=' + box.right + ', vw=' + box.vw + ')');
  ok(Math.abs((box.top + box.bottom) / 2 - box.vh / 2) <= 2, 'A: panel vertically centred (mid=' + (box.top + box.bottom) / 2 + ', vh/2=' + box.vh / 2 + ')');
  await page.screenshot({ path: '/tmp/shot-a-open.png' });

  // ---- B: seed saved answers, reload -> only unanswered remain
  await setStore({ entries: [
    { keys: ['=full name'], value: 'Priyesh Singh' },
    { keys: ['email'], value: 'priyesh@example.com' },
  ] });
  await page.reload();
  await sleep(2000);
  const labelsB = await pendingLabels();
  ok(await cardVisible(), 'B: panel auto-opens because some questions are missing');
  ok(labelsB.length === 5 && !labelsB.some((l) => /name|email/i.test(l)), 'B: only the 5 unanswered questions are listed (got ' + labelsB.length + ')');
  ok(/5 questions need an answer/.test(await sh("return root.querySelector('.sub').textContent")), 'B: header says 5 questions need an answer');
  const fillLabel = await sh("return root.querySelector('.fill').textContent");
  ok(/Fill saved answers \(2\)/.test(fillLabel), 'B: fill button shows 2 saved answers (got "' + fillLabel + '")');

  // ---- C: save a text answer from the panel -> saved + filled on page
  await page.evaluate(() => {
    const root = document.getElementById('formflash-host').shadowRoot;
    const row = [...root.querySelectorAll('.list .q')].find((r) => /favourite programming language/.test(r.textContent));
    const input = row.querySelector('input.field');
    input.value = 'Java';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await sleep(1500);
  ok(await page.inputValue('input[aria-label="fav lang"]') === 'Java', 'C: Enter in the panel saved and filled the page field');
  let got = await getStore('entries');
  ok(got.entries.some((e) => e.value === 'Java' && e.keys[0].startsWith('What is your favourite programming language')), 'C: answer stored with a plain keyword for the long question');
  ok((await pendingLabels()).length === 4, 'C: question left the missing list');

  // ---- D: radio via dropdown
  await page.evaluate(() => {
    const root = document.getElementById('formflash-host').shadowRoot;
    const row = [...root.querySelectorAll('.list .q')].find((r) => /Preferred role/.test(r.textContent));
    const sel = row.querySelector('select');
    sel.value = 'Data Engineer';
    row.querySelector('.btn--primary').click();
  });
  await sleep(1500);
  ok(await page.getAttribute('[data-value="Data Engineer"]', 'aria-checked') === 'true', 'D: radio picked in the panel got selected on the page');
  got = await getStore('entries');
  ok(got.entries.some((e) => e.keys[0] === '=Preferred role' && e.value === 'Data Engineer'), 'D: two-word label saved as exact keyword');

  // ---- E: checkboxes
  await page.evaluate(() => {
    const root = document.getElementById('formflash-host').shadowRoot;
    const row = [...root.querySelectorAll('.list .q')].find((r) => /Which of these/.test(r.textContent));
    const boxes = [...row.querySelectorAll('input[type=checkbox]')];
    boxes[0].checked = true; boxes[1].checked = true;
    row.querySelector('.btn--primary').click();
  });
  await sleep(1500);
  ok(await page.getAttribute('[data-value="Java"]', 'aria-checked') === 'true' &&
     await page.getAttribute('[data-value="Python"]', 'aria-checked') === 'true' &&
     await page.getAttribute('[data-value="Go"]', 'aria-checked') === 'false', 'E: checkbox picks (Java, Python) filled on the page, Go untouched');

  // ---- F: user types a field by hand -> offered for saving
  await page.fill('input[aria-label="Hometown"]', 'Sagwara');
  await page.locator('input[aria-label="Hometown"]').blur();
  await sleep(1500);
  ok(/You answered 1 yourself/.test(await sh("return root.querySelector('.learn > summary').textContent")), 'F: manual answer shows up under "You answered 1 yourself"');
  const learnVal = await sh("return root.querySelector('.learn-list input.field').value");
  ok(learnVal === 'Sagwara', 'F: the typed value is prefilled for saving (got "' + learnVal + '")');
  await page.screenshot({ path: '/tmp/shot-f-learn.png' });
  await sh("root.querySelector('.learn').open = true; root.querySelector('.learn-list .btn--primary').click();");
  await sleep(1200);
  got = await getStore('entries');
  ok(got.entries.some((e) => e.value === 'Sagwara' && /hometown/i.test(e.keys[0])), 'F: Save stored the answer the user typed');

  // ---- G: close, collapsed tab, new section reopens
  await sh("root.querySelector('.close').click()");
  ok(!(await cardVisible()) && (await tabVisible()), 'G: close collapses to the right-edge tab');
  const badge = await sh("return root.querySelector('.tab-badge').textContent");
  ok(badge === '1', 'G: tab badge shows 1 unanswered question (got "' + badge + '")');
  await page.screenshot({ path: '/tmp/shot-g-tab.png' });
  await page.click('#next');
  await sleep(2200);
  ok(await cardVisible(), 'G: next section with new unanswered questions reopens the panel');
  const labelsG = await pendingLabels();
  ok(labelsG.length === 2 && /join us/.test(labelsG[0]), 'G: panel lists the 2 questions of the new section (got ' + labelsG.join(' | ') + ')');

  // ---- H: Escape collapses, closed panel is not forced open again by same questions
  await sh("root.querySelector('.list .field').focus()");
  await page.keyboard.press('Escape');
  await sleep(300);
  ok(!(await cardVisible()), 'H: Escape collapses the panel');
  await page.evaluate(() => document.body.dispatchEvent(new Event('change', { bubbles: true })));
  await sleep(1200);
  ok(!(await cardVisible()), 'H: panel stays collapsed for questions it already asked about');

  // ---- I: auto-open can be turned off
  await setStore({ settings: { autoFill: true, showButton: true, autoOpen: false } });
  await page.goto(URL);
  await sleep(2000);
  ok(!(await cardVisible()) && (await tabVisible()), 'I: with auto-open off the panel stays collapsed');
  await sh("root.querySelector('.tab').click()");
  await sleep(500);
  ok(await cardVisible(), 'I: clicking the tab opens it manually');

  // ---- J: show panel off hides it
  await setStore({ settings: { autoFill: true, showButton: false, autoOpen: true } });
  await sleep(1500);
  const hidden = await page.evaluate(() => document.getElementById('formflash-host').style.display === 'none');
  ok(hidden, 'J: turning the panel off hides it');

  // ---- K: everything answered -> done state, no auto-open
  await setStore({ settings: { autoFill: true, showButton: true, autoOpen: true },
    entries: [
      { keys: ['=full name'], value: 'P' }, { keys: ['email'], value: 'e@x.com' },
      { keys: ['favourite programming language'], value: 'Java' }, { keys: ['=preferred role'], value: 'DevOps' },
      { keys: ['which of these do you know'], value: 'Go' }, { keys: ['=hometown'], value: 'X' },
      { keys: ['tell us about yourself'], value: 'Hi' },
    ] });
  await page.goto(URL);
  await sleep(2000);
  ok(!(await cardVisible()), 'K: nothing missing -> panel stays collapsed');
  ok(await sh("return root.querySelector('.tab-badge').textContent") === '✓', 'K: tab shows a check mark when everything has an answer');
  await sh("root.querySelector('.tab').click()");
  await sleep(600);
  await sh("root.querySelector('.fill').click()");
  await sleep(2000);
  ok(await page.inputValue('input[aria-label="Full name"]') === 'P' &&
     await page.getAttribute('[data-value="DevOps"]', 'aria-checked') === 'true', 'K: Fill saved answers fills text and radio');
  await page.screenshot({ path: '/tmp/shot-k-done.png' });

  // ---- L: popup messages
  const scan = await send(page, { type: 'FORMFLASH_SCAN' });
  ok(scan && scan.ok && scan.questions.length === 7 && scan.questions.every((q) => q.answer != null), 'L: popup SCAN reports 7 questions, all with saved answers');
  const tog = await send(page, { type: 'FORMFLASH_PANEL', action: 'toggle' });
  ok(tog && tog.ok, 'L: PANEL toggle message answered');
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
