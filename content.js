/* FormFlash content script. Runs on Google Forms and Microsoft Forms pages:
 * reads saved answers from chrome.storage.local, matches them against the
 * questions on the page and fills the inputs. Never submits a form and never
 * overwrites a field that already has something in it.
 */
(() => {
  'use strict';
  if (window.__formflashLoaded) return;
  window.__formflashLoaded = true;

  const M = globalThis.FormFlashMatcher;
  if (!M) {
    console.error('[FormFlash] lib/matcher.js was not loaded before content.js');
    return;
  }
  const { cleanLabel, findAnswer, pickOption, parseTokens, joinTokens, upsertEntry, normalizeForInput } = M;

  const DEFAULT_SETTINGS = { autoFill: true, showButton: true, autoOpen: true };
  let settings = { ...DEFAULT_SETTINGS };
  let ui = null;
  let hasFilledOnce = false; // auto-fill stays off until the user filled manually once
  let lastSig = ''; // question set we last reacted to (new section = new signature)
  let changeTimer = null;
  let refreshChain = Promise.resolve();
  let observer = null;
  const offered = new Set(); // questions the panel already asked about (no re-opening for them)
  const skipped = new Set(); // questions the user skipped on this page visit

  // helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isFormPage() {
    if (location.hostname === 'docs.google.com') {
      return /\/forms\/.+\/viewform/.test(location.pathname);
    }
    // design/edit pages are not response forms
    return !/\/design/i.test(location.pathname);
  }

  // storage
  async function getEntries() {
    const { entries } = await chrome.storage.local.get('entries');
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e) => e && Array.isArray(e.keys) && e.value != null && String(e.value).trim() !== '')
      .map((e) => ({
        keys: e.keys.map((k) => String(k).trim()).filter(Boolean),
        value: String(e.value),
      }));
  }

  // Save an answer typed into the panel. Fills a matching template row when
  // there is one, otherwise adds a new row (see upsertEntry in lib/matcher.js).
  async function saveAnswer(label, value) {
    const { entries } = await chrome.storage.local.get('entries');
    const base = Array.isArray(entries) ? entries : M.DEFAULT_ENTRIES;
    await chrome.storage.local.set({ entries: upsertEntry(base, label, value) });
  }

  async function loadSettings() {
    try {
      const { settings: saved } = await chrome.storage.local.get('settings');
      settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    }
    // new answers saved from the popup or another tab: re-check what is missing
    if (changes.settings || changes.entries) onPageChanged();
  });

  // finding questions
  const SITES = [
    // Google Forms
    { item: 'div[role="listitem"]', title: '[role="heading"]', requireTitle: true },
    // Microsoft Forms
    { item: '[data-automation-id="questionItem"]', title: '[data-automation-id="questionTitle"]', requireTitle: false },
  ];

  function getQuestions() {
    const out = [];
    for (const site of SITES) {
      document.querySelectorAll(site.item).forEach((el) => {
        // Google nests listitems for checkbox options - skip those
        if (el.parentElement && el.parentElement.closest(site.item)) return;
        const t = el.querySelector(site.title);
        if (!t && site.requireTitle) return;
        const label = cleanLabel(t ? t.textContent : el.textContent.slice(0, 150));
        if (label) out.push({ el, label });
      });
    }
    return out;
  }

  function optionLabel(o) {
    if (o.matches('input')) {
      let lab = o.closest('label');
      if (!lab && o.id) {
        const id = window.CSS && CSS.escape ? CSS.escape(o.id) : o.id;
        lab = document.querySelector('label[for="' + id + '"]');
      }
      return (lab && lab.textContent) || o.getAttribute('aria-label') || o.value || '';
    }
    return o.getAttribute('data-value') || o.getAttribute('aria-label') || o.textContent || '';
  }

  const OTHER = '__other_option__';
  const SKIP_INPUT_TYPES = ['hidden', 'radio', 'checkbox', 'button', 'submit', 'reset', 'file', 'image', 'password'];

  function toOptions(nodes) {
    return nodes
      .filter((n) => n.getAttribute('data-value') !== OTHER)
      .map((n) => ({ el: n, label: optionLabel(n).trim() }))
      .filter((o) => o.label);
  }

  function dropdownOptions(scope) {
    return [...scope.querySelectorAll('[role="option"]')]
      .map((o) => ({ el: o, label: (o.getAttribute('data-value') || o.textContent || '').trim() }))
      .filter((o) => o.label);
  }

  // Grid questions (multiple choice / checkbox grid): every row has its own
  // options, so each row has to be matched on its own.
  function detectGrid(el) {
    const rows = [...el.querySelectorAll('tr, [role="row"]')];
    const parsed = [];
    for (const row of rows) {
      const group = [
        ...row.querySelectorAll('[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]'),
      ];
      // a real grid row has several options side by side; single-option rows
      // are normal questions rendered as tables
      if (group.length < 2) continue;

      let label = '';
      const header = row.querySelector('[role="rowheader"], th');
      if (header) label = header.textContent;
      if (!label) {
        const cells = [...row.querySelectorAll('[role="gridcell"], td')];
        const candidates = cells.length ? cells : [...row.querySelectorAll('div')];
        for (const cell of candidates) {
          if (cell.querySelector('[role="radio"], [role="checkbox"], input')) continue;
          const text = (cell.textContent || '').trim();
          if (text) {
            label = text;
            break;
          }
        }
      }
      label = cleanLabel(label);
      if (!label) continue;

      const first = group[0];
      const isCheckbox = first.matches('input[type="checkbox"]') || first.getAttribute('role') === 'checkbox';
      parsed.push({
        label,
        control: { type: isCheckbox ? 'checkbox' : 'radio', options: toOptions(group) },
      });
    }
    return parsed.length >= 2 ? parsed : null;
  }

  function detect(el) {
    const grid = detectGrid(el);
    if (grid) return { type: 'grid', rows: grid };

    const radios = [...el.querySelectorAll('[role="radio"], input[type="radio"]')];
    if (radios.length) return { type: 'radio', options: toOptions(radios) };

    const checks = [...el.querySelectorAll('[role="checkbox"], input[type="checkbox"]')];
    if (checks.length) return { type: 'checkbox', options: toOptions(checks) };

    const select = el.querySelector('select');
    if (select) {
      const options = [...select.options]
        .filter((o) => o.value !== '')
        .map((o) => ({ el: o, label: o.textContent.trim() }));
      return { type: 'select', el: select, options };
    }

    const listbox = el.querySelector('[role="listbox"]');
    if (listbox) return { type: 'dropdown', el: listbox, options: dropdownOptions(el) };

    const input = [...el.querySelectorAll('textarea, input')].find(
      (i) =>
        !SKIP_INPUT_TYPES.includes((i.type || '').toLowerCase()) &&
        !/other/i.test(i.getAttribute('aria-label') || '')
    );
    if (input) return { type: 'text', el: input, options: [] };

    // some providers render open answers as contenteditable rich text
    const editable = [...el.querySelectorAll('[contenteditable="true"]')].find(
      (n) => !n.closest('[role="listbox"], [role="combobox"]')
    );
    if (editable) return { type: 'contenteditable', el: editable, options: [] };

    const combo = el.querySelector('[role="combobox"]');
    if (combo) return { type: 'dropdown', el: combo, options: dropdownOptions(el) };

    return null; // file upload, section header, image, etc.
  }

  // Grid rows become their own tasks so the report stays per row.
  function collectTasks() {
    const tasks = [];
    for (const q of getQuestions()) {
      const ctl = detect(q.el);
      if (!ctl) continue;
      if (ctl.type === 'grid') {
        for (const row of ctl.rows) {
          tasks.push({
            label: row.label,
            altLabel: cleanLabel(q.label + ' ' + row.label),
            ctl: row.control,
            el: q.el,
          });
        }
      } else {
        tasks.push({ label: q.label, ctl, el: q.el });
      }
    }
    return tasks;
  }

  // highlighting filled fields
  const FLASH_ATTR = 'data-formflash-filled';

  function ensureFlashStyle() {
    if (document.getElementById('formflash-style')) return;
    const style = document.createElement('style');
    style.id = 'formflash-style';
    style.textContent =
      '[data-formflash-filled]{outline:2px solid #f59e0b!important;outline-offset:2px;' +
      'border-radius:6px;transition:outline-color .3s ease}';
    (document.head || document.documentElement).appendChild(style);
  }

  function flash(el) {
    if (!el) return;
    const target =
      el.closest('label, [role="radio"], [role="checkbox"], [role="option"], input, textarea, select, [contenteditable="true"]') ||
      el;
    try {
      target.setAttribute(FLASH_ATTR, '');
      setTimeout(() => target.removeAttribute(FLASH_ATTR), 1800);
    } catch {}
  }

  // filling
  function realClick(el) {
    if (el.matches('input, option')) {
      el.click();
      return;
    }
    ['mousedown', 'mouseup', 'click'].forEach((type) =>
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    );
  }

  const isChecked = (el) => el.getAttribute('aria-checked') === 'true' || el.checked === true;

  // React-style forms ignore plain `el.value = x`; use the native setter + events
  function setText(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function fillText(el, answer) {
    const type = (el.getAttribute('type') || el.type || 'text').toLowerCase();
    const value = normalizeForInput(answer, type);
    if (!value) return false; // nothing usable to write (e.g. a date we could not parse)
    setText(el, value);
    flash(el);
    return true;
  }

  function fillEditable(el, value) {
    el.focus();
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, value);
    } catch {
      inserted = false;
    }
    if (!inserted) el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
    flash(el);
    return true;
  }

  async function fillDropdown(box, scope, answer) {
    realClick(box);
    await sleep(300);
    let opts = dropdownOptions(scope);
    if (!opts.length) opts = dropdownOptions(document);
    const best = pickOption(opts, answer);
    if (best) {
      realClick(best.el);
      await sleep(200);
      flash(best.el);
      return true;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  async function fillControl(task, answer) {
    const ctl = task.ctl;
    switch (ctl.type) {
      case 'text': {
        if (ctl.el.value && ctl.el.value.trim() !== '') return true; // keep what the user typed
        return fillText(ctl.el, answer);
      }
      case 'contenteditable': {
        if ((ctl.el.textContent || '').trim() !== '') return true;
        return fillEditable(ctl.el, String(answer));
      }
      case 'radio': {
        const best = pickOption(ctl.options, answer);
        if (!best) return false;
        if (!isChecked(best.el)) realClick(best.el);
        flash(best.el);
        return true;
      }
      case 'checkbox': {
        const tokens = parseTokens(answer);
        let hit = 0;
        for (const t of tokens) {
          const best = pickOption(ctl.options, t);
          if (best) {
            hit++;
            if (!isChecked(best.el)) realClick(best.el);
            flash(best.el);
          }
        }
        return hit > 0;
      }
      case 'select': {
        const best = pickOption(ctl.options, answer);
        if (!best) return false;
        ctl.el.value = best.el.value;
        ctl.el.dispatchEvent(new Event('input', { bubbles: true }));
        ctl.el.dispatchEvent(new Event('change', { bubbles: true }));
        flash(ctl.el);
        return true;
      }
      case 'dropdown':
        return fillDropdown(ctl.el, task.el, answer);
      default:
        return false;
    }
  }

  // the fill run
  async function fillForm(options = {}) {
    const silent = !!options.silent;
    const entries = await getEntries();
    const tasks = collectTasks();
    const report = { filled: 0, total: 0, unmatched: [], filledLabels: [] };

    for (const task of tasks) {
      report.total++;

      let answer = findAnswer(task.label, entries);
      if (answer == null && task.altLabel) answer = findAnswer(task.altLabel, entries);

      let ok = false;
      if (answer != null) {
        try {
          ok = await fillControl(task, answer);
        } catch (err) {
          console.warn('[FormFlash] could not fill:', task.label, err);
        }
      }
      if (ok) {
        report.filled++;
        if (report.filledLabels.length < 60) report.filledLabels.push(task.label);
      } else if (!report.unmatched.some((u) => u.label === task.label && u.type === task.ctl.type)) {
        report.unmatched.push({
          label: task.label,
          type: task.ctl.type,
          options: (task.ctl.options || []).map((o) => o.label).slice(0, 30),
          reason: answer == null ? 'no-match' : 'value-mismatch',
        });
      }
    }

    await chrome.storage.local.set({
      lastRun: {
        url: location.href.split('#')[0],
        at: Date.now(),
        filled: report.filled,
        total: report.total,
        unmatched: report.unmatched,
        filledLabels: report.filledLabels,
      },
    });

    if (!silent) {
      hasFilledOnce = true;
      lastSig = tasks.map((t) => t.label).join('|');
    }
    return report;
  }

  // what is on the page right now
  function questionSignature() {
    return collectTasks()
      .map((t) => t.label)
      .join('|');
  }

  const itemKey = (it) => it.type + '|' + it.label;

  // What the user has put into a control on the page ('' when empty or unknown).
  function readControl(ctl) {
    switch (ctl.type) {
      case 'text':
        return (ctl.el.value || '').trim();
      case 'contenteditable':
        return (ctl.el.textContent || '').trim();
      case 'select': {
        const o = ctl.el.selectedOptions && ctl.el.selectedOptions[0];
        return ctl.el.value && o ? o.textContent.trim() : '';
      }
      case 'radio': {
        const o = (ctl.options || []).find((x) => isChecked(x.el));
        return o ? o.label : '';
      }
      case 'checkbox':
        return joinTokens((ctl.options || []).filter((x) => isChecked(x.el)).map((x) => x.label));
      default:
        return ''; // dropdown widgets do not expose their value in a generic way
    }
  }

  // current state of a control on the page
  function controlState(ctl) {
    if (ctl.type === 'dropdown') return null;
    return readControl(ctl) ? 'filled' : 'empty';
  }

  // Read-only pass over the page: every question we can fill, the saved answer
  // for it (if any) and what is currently in the field.
  async function analyze() {
    const entries = await getEntries();
    return collectTasks().map((task) => {
      let answer = findAnswer(task.label, entries);
      if (answer == null && task.altLabel) answer = findAnswer(task.altLabel, entries);
      const el = task.ctl.el;
      return {
        label: task.label,
        type: task.ctl.type,
        options: (task.ctl.options || []).map((o) => o.label).slice(0, 40),
        inputType: task.ctl.type === 'text' ? (el.getAttribute('type') || el.type || 'text').toLowerCase() : '',
        multiline: !!(el && el.tagName === 'TEXTAREA'),
        answer: answer == null ? null : String(answer),
        current: readControl(task.ctl),
        filled: controlState(task.ctl) === 'filled',
      };
    });
  }

  // the toolbar popup lists these as soon as it opens
  async function scanForm() {
    return (await analyze()).map(({ label, type, options, answer, filled }) => ({
      label,
      type,
      options,
      answer,
      filled,
    }));
  }

  // fill one question, used by the per question buttons
  async function fillOne(label) {
    const entries = await getEntries();
    const task = collectTasks().find((t) => t.label === label);
    if (!task) return { ok: false, reason: 'not-found' };
    let answer = findAnswer(task.label, entries);
    if (answer == null && task.altLabel) answer = findAnswer(task.altLabel, entries);
    if (answer == null) return { ok: false, reason: 'no-answer' };
    const filled = await fillControl(task, answer);
    return { ok: true, filled: !!filled };
  }

  // reacting to the page
  function contextAlive() {
    return !!(chrome.runtime && chrome.runtime.id);
  }

  // After the extension is reloaded, the old script keeps running in open tabs
  // but every chrome.* call throws. Shut it down quietly instead.
  function teardown() {
    clearTimeout(changeTimer);
    if (observer) observer.disconnect();
    observer = null;
    if (ui) ui.host.remove();
    ui = null;
  }

  function onPageChanged() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(handleChange, 700);
  }

  async function handleChange() {
    if (!contextAlive()) return teardown();
    if (!isFormPage()) return;
    try {
      const sig = questionSignature();
      if (sig && sig !== lastSig) {
        // a new page or section of the form showed up
        lastSig = sig;
        if (settings.autoFill && hasFilledOnce) {
          const report = await fillForm({ silent: true });
          if (report.filled > 0) {
            const left = report.unmatched.length;
            await refreshPanel({ allowAutoOpen: true });
            if (ui) {
              ui.say(
                `Filled ${report.filled} more on this page.` + (left ? ` ${left} still need an answer.` : '')
              );
            }
            return;
          }
        }
      }
      await refreshPanel({ allowAutoOpen: true });
    } catch (err) {
      console.warn('[FormFlash] refresh failed:', err);
    }
  }

  function observeForms() {
    if (observer) return;
    // Microsoft Forms navigates without reloading, so it always watches
    if (!isFormPage() && location.hostname === 'docs.google.com') return;
    observer = new MutationObserver(onPageChanged);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // typing or picking an answer by hand changes what the panel should offer
    ['change', 'focusout'].forEach((type) =>
      document.addEventListener(
        type,
        (e) => {
          if (!ui || e.target !== ui.host) onPageChanged();
        },
        true
      )
    );
  }

  // messages from the popup and the shortcut
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'FORMFLASH_PING') {
      sendResponse({ ok: true, onForm: isFormPage() });
      return;
    }
    if (msg.type === 'FORMFLASH_SCAN') {
      scanForm()
        .then((questions) => sendResponse({ ok: true, questions }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    if (msg.type === 'FORMFLASH_FILL_ONE') {
      fillOne(msg.label)
        .then((res) => {
          onPageChanged();
          sendResponse(res);
        })
        .catch((err) => sendResponse({ ok: false, reason: String(err) }));
      return true;
    }
    if (msg.type === 'FORMFLASH_FILL') {
      fillForm()
        .then((report) => {
          onPageChanged();
          sendResponse({ ok: true, report });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // keep the channel open for the async reply
    }
    if (msg.type === 'FORMFLASH_PANEL') {
      refreshPanel({ force: true })
        .then(() => {
          if (!ui) return sendResponse({ ok: false });
          if (msg.action === 'close') ui.setOpen(false);
          else if (msg.action === 'open') ui.setOpen(true, { focus: true });
          else ui.setOpen(!ui.isOpen(), { focus: true });
          sendResponse({ ok: true });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
  });

  // The panel: docked to the right edge, vertically centered. It collapses to a
  // slim tab and opens by itself when a question has no saved answer.
  const PANEL_CSS = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }
    .dock {
      --bg: #ffffff; --soft: #f8f8f6; --line: #e8e6e1; --line-strong: #d9d6cf;
      --text: #17181a; --muted: #6b6f76;
      --accent: #059669; --accent-hover: #047857; --on-accent: #ffffff; --ring: rgba(5,150,105,.28);
      --warn: #b45309; --badge: #fbbf24; --on-badge: #3b2300; --err: #dc2626;
      display: flex; justify-content: flex-end;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--text); -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      .dock {
        --bg: #141517; --soft: #1a1c1e; --line: #282b2e; --line-strong: #3a3e42;
        --text: #ececec; --muted: #9aa0a6;
        --accent: #10b981; --accent-hover: #34d399; --on-accent: #04261c; --ring: rgba(16,185,129,.35);
        --warn: #fbbf24; --err: #f87171;
      }
    }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:focus-visible, .field:focus-visible, .opt input:focus-visible, summary:focus-visible {
      outline: 2px solid var(--accent); outline-offset: 2px;
    }

    .tab {
      display: flex; flex-direction: column; align-items: center; gap: 9px;
      padding: 12px 6px 14px; border: 0; border-radius: 10px 0 0 10px;
      background: var(--accent); color: var(--on-accent); font-weight: 650;
      box-shadow: -3px 2px 16px rgba(0,0,0,.2);
      transition: background .12s ease, padding .12s ease;
    }
    .tab:hover { background: var(--accent-hover); padding-right: 9px; }
    .tab-word { writing-mode: vertical-rl; font-size: 12.5px; letter-spacing: .02em; }
    .tab-badge {
      min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
      display: grid; place-items: center; font-size: 11.5px; font-weight: 700;
      background: var(--badge); color: var(--on-badge);
    }
    .tab-badge--done { background: rgba(255,255,255,.22); color: inherit; }

    .card {
      width: 316px; max-width: calc(100vw - 6px); max-height: min(74vh, 600px);
      display: flex; flex-direction: column;
      background: var(--bg); border: 1px solid var(--line-strong); border-right: 0;
      border-radius: 12px 0 0 12px; box-shadow: -10px 6px 34px rgba(0,0,0,.18);
    }
    .card--enter { animation: ff-in .22s ease-out; }
    @keyframes ff-in { from { opacity: 0; transform: translateX(28px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .card--enter { animation: none; } .tab { transition: none; } }

    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 12px 10px 10px 14px; }
    .title { font-weight: 650; font-size: 13.5px; letter-spacing: -.01em; }
    .sub { color: var(--muted); font-size: 12px; margin-top: 1px; }
    .icon {
      width: 26px; height: 26px; display: grid; place-items: center; flex: none;
      border: 0; border-radius: 7px; background: transparent; color: var(--muted);
    }
    .icon:hover { background: var(--soft); color: var(--text); }
    .bar { height: 3px; background: var(--line); }
    .bar-fill { height: 100%; width: 0; background: var(--accent); transition: width .2s ease; }

    .body { overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
    .list { list-style: none; }
    .q { padding: 11px 14px 12px; border-bottom: 1px solid var(--line); }
    .q-label {
      font-weight: 600; word-break: break-word;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .q-hint { color: var(--muted); font-size: 11.5px; margin-top: 1px; }
    .field {
      display: block; width: 100%; margin-top: 7px; padding: 7px 9px;
      font: inherit; color: var(--text); background: var(--bg);
      border: 1px solid var(--line-strong); border-radius: 7px;
    }
    .field:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
    .field--bad { border-color: var(--err); }
    textarea.field { resize: vertical; min-height: 56px; }
    .opts { margin-top: 7px; max-height: 136px; overflow-y: auto; border: 1px solid var(--line-strong); border-radius: 7px; }
    .opt { display: flex; gap: 8px; align-items: flex-start; padding: 6px 9px; cursor: pointer; }
    .opt + .opt { border-top: 1px solid var(--line); }
    .opt input { margin-top: 2px; accent-color: var(--accent); }
    .actions { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
    .btn {
      padding: 6px 11px; font-weight: 600; font-size: 12.5px; border-radius: 7px;
      background: var(--bg); border: 1px solid var(--line-strong);
    }
    .btn:hover:not(:disabled) { background: var(--soft); }
    .btn:disabled { opacity: .55; cursor: default; }
    .btn--primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .btn--primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
    .btn--quiet { border-color: transparent; background: transparent; color: var(--muted); font-weight: 500; }

    .learn { border-bottom: 1px solid var(--line); }
    .learn > summary { padding: 10px 14px; cursor: pointer; font-weight: 600; font-size: 12.5px; color: var(--muted); list-style: none; }
    .learn > summary::-webkit-details-marker { display: none; }
    .learn > summary::before { content: "\\25B8"; display: inline-block; width: 14px; }
    .learn[open] > summary::before { content: "\\25BE"; }
    .learn-note { padding: 0 14px 4px; color: var(--muted); font-size: 12px; }
    .learn .q:last-child { border-bottom: 0; }
    .done { padding: 18px 14px; color: var(--muted); }

    .foot { padding: 10px 14px 12px; border-top: 1px solid var(--line); background: var(--soft); border-radius: 0 0 0 11px; }
    .foot .btn--primary { width: 100%; padding: 8px 12px; }
    .foot-row { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
    .foot .btn--quiet { padding: 3px 0; font-size: 12px; text-decoration: underline; text-underline-offset: 2px; }
    .toast { margin-top: 8px; font-size: 12px; color: var(--text); }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const FIELD_INPUT_TYPES = ['date', 'time', 'number', 'email', 'tel', 'url'];

  // The control used to type or pick an answer inside the panel.
  function buildAnswerControl(it, initial) {
    const options = it.options || [];
    if (it.type === 'checkbox' && options.length && options.length <= 30) {
      const chosen = new Set(parseTokens(initial));
      const box = el('div', 'opts');
      const boxes = options.map((label) => {
        const row = el('label', 'opt');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = chosen.has(label);
        row.append(input, el('span', '', label));
        box.append(row);
        return { input, label };
      });
      return { node: box, focusEl: boxes[0].input, read: () => joinTokens(boxes.filter((b) => b.input.checked).map((b) => b.label)) };
    }
    if (['radio', 'select', 'dropdown'].includes(it.type) && options.length) {
      const select = el('select', 'field');
      const first = el('option', '', 'Pick an answer');
      first.value = '';
      select.append(first);
      options.forEach((label) => {
        const o = el('option', '', label);
        o.value = label;
        select.append(o);
      });
      select.value = options.includes(initial) ? initial : '';
      return { node: select, focusEl: select, read: () => select.value };
    }
    const multiline = it.multiline || it.type === 'contenteditable';
    const field = el(multiline ? 'textarea' : 'input', 'field');
    if (!multiline) field.type = FIELD_INPUT_TYPES.includes(it.inputType) ? it.inputType : 'text';
    if (multiline) field.rows = 2;
    field.placeholder = it.type === 'checkbox' ? 'Choices, comma separated' : 'Type your answer';
    field.value = initial || '';
    return { node: field, focusEl: field, read: () => field.value, multiline };
  }

  function ensureUi() {
    if (ui) return ui;
    if (!isFormPage()) return null;
    // a panel left behind by a copy of this script from before an extension reload
    const stale = document.getElementById('formflash-host');
    if (stale) stale.remove();

    const host = document.createElement('div');
    host.id = 'formflash-host';
    host.style.cssText = 'position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    try {
      // constructable stylesheets are not blocked by a page's content security policy
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PANEL_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = PANEL_CSS;
      root.append(style);
    }

    root.append(
      Object.assign(el('div', 'dock'), {
        innerHTML: `
        <button type="button" class="tab" aria-expanded="false" aria-controls="card">
          <span class="tab-badge"></span>
          <span class="tab-word">FormFlash</span>
        </button>
        <section class="card" id="card" aria-label="FormFlash" hidden>
          <header class="head">
            <div>
              <div class="title">FormFlash</div>
              <div class="sub" role="status" aria-live="polite"></div>
            </div>
            <button type="button" class="icon close" aria-label="Collapse panel" title="Collapse (Esc)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
            </button>
          </header>
          <div class="bar"><div class="bar-fill"></div></div>
          <div class="body">
            <ul class="list"></ul>
            <details class="learn" hidden>
              <summary></summary>
              <p class="learn-note">Save what you typed so the next form fills itself.</p>
              <ul class="learn-list"></ul>
            </details>
            <p class="done" hidden></p>
          </div>
          <footer class="foot">
            <button type="button" class="btn btn--primary fill"></button>
            <div class="foot-row">
              <button type="button" class="btn btn--quiet stop">Don't open automatically</button>
            </div>
            <p class="toast" role="status" aria-live="polite" hidden></p>
          </footer>
        </section>`,
      })
    );

    const q = (s) => root.querySelector(s);
    const parts = {
      tab: q('.tab'),
      badge: q('.tab-badge'),
      card: q('.card'),
      sub: q('.sub'),
      barFill: q('.bar-fill'),
      list: q('.list'),
      learn: q('.learn'),
      learnSummary: q('.learn > summary'),
      learnList: q('.learn-list'),
      done: q('.done'),
      fill: q('.fill'),
      toast: q('.toast'),
    };

    let open = false;
    let toastTimer;

    const say = (text) => {
      parts.toast.textContent = text;
      parts.toast.hidden = !text;
      clearTimeout(toastTimer);
      if (text) toastTimer = setTimeout(() => (parts.toast.hidden = true), 7000);
    };

    const setOpen = (next, opts = {}) => {
      if (next === open) {
        if (next && opts.focus) focusFirst();
        return;
      }
      open = next;
      parts.card.hidden = !open;
      parts.tab.hidden = open;
      parts.tab.setAttribute('aria-expanded', String(open));
      if (open) {
        parts.card.classList.remove('card--enter');
        void parts.card.offsetWidth; // restart the slide-in
        parts.card.classList.add('card--enter');
        if (opts.focus) focusFirst();
      } else if (opts.focus !== false) {
        parts.tab.focus({ preventScroll: true });
      }
    };

    function focusFirst() {
      const f = root.querySelector('.list .field, .list .opt input, .fill');
      if (f) f.focus({ preventScroll: true });
    }

    parts.tab.addEventListener('click', () => {
      setOpen(true, { focus: true });
      refreshPanel({ force: true });
    });
    q('.close').addEventListener('click', () => {
      userClosed = true;
      setOpen(false);
    });
    q('.card').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        userClosed = true;
        setOpen(false);
      }
    });
    // the form page has its own key handlers; keep typing in the panel to ourselves
    ['keydown', 'keyup', 'keypress'].forEach((t) => q('.dock').addEventListener(t, (e) => e.stopPropagation()));

    parts.fill.addEventListener('click', async () => {
      parts.fill.disabled = true;
      const idle = parts.fill.textContent;
      parts.fill.textContent = 'Filling...';
      try {
        const r = await fillForm();
        const left = r.unmatched.length;
        say(`Filled ${r.filled} of ${r.total} questions.` + (left ? ` ${left} still need an answer.` : ' Check everything before you submit.'));
      } catch (err) {
        say('Filling failed. Reload the page and try again.');
        console.error('[FormFlash]', err);
      } finally {
        parts.fill.textContent = idle;
        parts.fill.disabled = false;
        refreshPanel({ force: true });
      }
    });

    q('.stop').addEventListener('click', async () => {
      settings.autoOpen = false;
      try {
        await chrome.storage.local.set({ settings });
      } catch {}
      say('Okay. The panel stays collapsed until you open it. You can turn this back on in the FormFlash popup, under Settings.');
    });

    ui = { host, root, parts, say, setOpen, isOpen: () => open };
    document.documentElement.appendChild(host);
    return ui;
  }

  let userClosed = false;

  function questionRow(it, mode) {
    const li = el('li', 'q');
    const label = el('div', 'q-label', it.label);
    label.title = it.label;
    li.append(label);
    if (mode === 'pending' && (it.type === 'radio' || it.type === 'checkbox')) {
      li.append(el('div', 'q-hint', it.type === 'radio' ? 'Choose one' : 'Choose any'));
    }

    const ctl = buildAnswerControl(it, mode === 'learn' ? it.current : '');
    li.append(ctl.node);

    const actions = el('div', 'actions');
    const save = el('button', 'btn btn--primary', mode === 'learn' ? 'Save' : 'Save & fill');
    save.type = 'button';
    const run = async () => {
      const value = ctl.read().trim();
      if (!value) {
        ctl.focusEl.classList.add('field--bad');
        ctl.focusEl.focus();
        ui.say('Type or pick an answer first.');
        return;
      }
      save.disabled = true;
      try {
        await saveAnswer(it.label, value);
        if (mode === 'pending') await fillOne(it.label);
        ui.say('Saved. This question fills itself from now on.');
      } catch (err) {
        ui.say('Could not save. Reload the page and try again.');
        console.error('[FormFlash]', err);
        save.disabled = false;
        return;
      }
      refreshPanel({ force: true });
    };
    save.addEventListener('click', run);
    actions.append(save);
    if (mode === 'pending') {
      const skip = el('button', 'btn btn--quiet', 'Skip');
      skip.type = 'button';
      skip.addEventListener('click', () => {
        skipped.add(itemKey(it));
        refreshPanel({ force: true });
      });
      actions.append(skip);
    }
    li.append(actions);

    if (ctl.node.tagName === 'INPUT' || ctl.node.tagName === 'TEXTAREA') {
      ctl.node.addEventListener('input', () => ctl.node.classList.remove('field--bad'));
      ctl.node.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        if (ctl.multiline && !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        run();
      });
    }
    return li;
  }

  // Work out what the panel should show, draw it, and open it when something
  // on the page has no saved answer. Runs one at a time.
  function refreshPanel(opts = {}) {
    refreshChain = refreshChain.then(() => doRefresh(opts)).catch((err) => console.warn('[FormFlash]', err));
    return refreshChain;
  }

  let lastRenderKey = '';

  async function doRefresh(opts) {
    if (!contextAlive()) return teardown();
    if (!isFormPage()) return;
    if (!settings.showButton) {
      if (ui) ui.host.style.display = 'none';
      return;
    }
    const items = await analyze();
    if (!items.length) {
      if (ui) ui.host.style.display = 'none';
      return;
    }
    const u = ensureUi();
    if (!u) return;
    u.host.style.display = '';

    const seen = new Set();
    const pending = [];
    const learn = [];
    let answered = 0;
    let skippedCount = 0;
    for (const it of items) {
      const key = itemKey(it);
      if (seen.has(key)) continue;
      seen.add(key);
      if (it.answer != null) {
        answered++;
        continue;
      }
      if (skipped.has(key)) {
        skippedCount++;
        continue;
      }
      (it.current ? learn : pending).push(it);
    }
    const total = seen.size;

    // open by itself when there is a question we have never asked about
    const fresh = pending.filter((it) => !offered.has(itemKey(it)));
    if (opts.allowAutoOpen && settings.autoOpen && fresh.length) {
      pending.forEach((it) => offered.add(itemKey(it)));
      userClosed = false;
      u.setOpen(true, { focus: false });
    }

    const key = JSON.stringify([
      pending.map(itemKey),
      learn.map((it) => [itemKey(it), it.current]),
      answered,
      total,
      skippedCount,
    ]);
    const typing = u.root.activeElement && u.root.activeElement.closest && u.root.activeElement.closest('.list, .learn');
    if (key !== lastRenderKey && (!typing || opts.force)) {
      lastRenderKey = key;
      renderPanel(u, { pending, learn, answered, total, skippedCount });
    }
  }

  function renderPanel(u, { pending, learn, answered, total, skippedCount }) {
    const p = u.parts;
    const n = pending.length;
    p.sub.textContent = n
      ? `${n} question${n === 1 ? ' needs' : 's need'} an answer`
      : answered === total
        ? 'Every question has a saved answer'
        : 'Nothing left to answer here';
    p.barFill.style.width = total ? Math.round((answered / total) * 100) + '%' : '0%';

    p.badge.className = 'tab-badge' + (n ? '' : ' tab-badge--done');
    p.badge.textContent = n ? String(n) : '✓';
    p.tab.setAttribute('aria-label', n ? `FormFlash: ${n} question${n === 1 ? '' : 's'} need an answer. Open panel` : 'FormFlash: open panel');

    p.list.textContent = '';
    pending.forEach((it) => p.list.append(questionRow(it, 'pending')));

    p.learnList.textContent = '';
    p.learn.hidden = !learn.length;
    if (learn.length) {
      p.learnSummary.textContent = `You answered ${learn.length} yourself`;
      learn.forEach((it) => p.learnList.append(questionRow(it, 'learn')));
      if (!n) p.learn.open = true;
    }

    p.done.hidden = n > 0 || learn.length > 0;
    p.done.textContent = skippedCount
      ? `You skipped ${skippedCount} question${skippedCount === 1 ? '' : 's'}. They stay blank until you reload.`
      : 'Every question on this page already has a saved answer.';

    p.fill.textContent = answered ? `Fill saved answers (${answered})` : 'No saved answers match yet';
    p.fill.disabled = !answered;
  }

  async function init() {
    await loadSettings();
    if (!isFormPage() && location.hostname === 'docs.google.com') return;
    ensureFlashStyle();
    observeForms();
    // forms render late; the observer catches the questions, these cover quiet pages
    onPageChanged();
    setTimeout(onPageChanged, 2500);
    setTimeout(onPageChanged, 6000);
  }

  init();
})();
