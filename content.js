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
  const { cleanLabel, findAnswer, pickOption, parseTokens, normalizeForInput } = M;

  const DEFAULT_SETTINGS = { autoFill: true, showButton: true };
  let settings = { ...DEFAULT_SETTINGS };
  let ui = null;
  let hasFilledOnce = false; // auto-fill stays off until the user filled manually once
  let lastAutoSig = '';
  let autoTimer = null;
  let observer = null;

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

  async function loadSettings() {
    try {
      const { settings: saved } = await chrome.storage.local.get('settings');
      settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    if (ui) ui.btn.hidden = !settings.showButton;
    if (settings.autoFill) scheduleAutoFill();
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
  const SKIP_INPUT_TYPES = ['hidden', 'radio', 'checkbox', 'button', 'submit', 'reset', 'file', 'image'];

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
      lastAutoSig = tasks.map((t) => t.label).join('|');
    }
    return report;
  }

  // auto-fill when a form shows new questions
  function questionSignature() {
    return collectTasks()
      .map((t) => t.label)
      .join('|');
  }

  function scheduleAutoFill() {
    if (!settings.autoFill || !hasFilledOnce || !isFormPage()) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
      const sig = questionSignature();
      if (!sig || sig === lastAutoSig) return;
      lastAutoSig = sig;
      try {
        const report = await fillForm({ silent: true });
        if (ui) {
          if (report.filled > 0) {
            const left = report.unmatched.length;
            ui.say(
              `Filled ${report.filled} more on this page.` +
                (left ? ` ${left} still need a saved answer.` : '')
            );
          }
          refreshButtonHint();
        }
      } catch (err) {
        console.warn('[FormFlash] auto-fill failed:', err);
      }
    }, 800);
  }

  function observeForms() {
    if (observer || !isFormPage()) return;
    observer = new MutationObserver(() => scheduleAutoFill());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // current state of a control on the page
  function controlState(ctl) {
    switch (ctl.type) {
      case 'radio':
      case 'checkbox':
        return (ctl.options || []).some((o) => isChecked(o.el)) ? 'filled' : 'empty';
      case 'select':
        return ctl.el.value ? 'filled' : 'empty';
      case 'text':
        return ctl.el.value && ctl.el.value.trim() ? 'filled' : 'empty';
      case 'contenteditable':
        return (ctl.el.textContent || '').trim() ? 'filled' : 'empty';
      default:
        return null; // dropdown widgets do not expose their value in a generic way
    }
  }

  // read-only pass over the page: every question we can fill and what we have for it.
  // The popup uses this to show the questions as soon as it opens, before any fill.
  async function scanForm() {
    const entries = await getEntries();
    return collectTasks().map((task) => {
      let answer = findAnswer(task.label, entries);
      if (answer == null && task.altLabel) answer = findAnswer(task.altLabel, entries);
      return {
        label: task.label,
        type: task.ctl.type,
        options: (task.ctl.options || []).map((o) => o.label).slice(0, 40),
        answer: answer == null ? null : String(answer),
        filled: controlState(task.ctl) === 'filled',
      };
    });
  }

  // fill one question, used by the per question button in the popup
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
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, reason: String(err) }));
      return true;
    }
    if (msg.type === 'FORMFLASH_FILL') {
      fillForm()
        .then((report) => sendResponse({ ok: true, report }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // keep the channel open for the async reply
    }
  });

  // fill button on the page itself
  function ensureUi() {
    if (ui) return ui;
    if (!isFormPage() || document.getElementById('formflash-host')) return null;

    const host = document.createElement('div');
    host.id = 'formflash-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
                font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
                color: #18181b; }
        button { font: 600 13px/1 inherit; color: #fff; background: #18181b;
                 border: none; border-radius: 10px; padding: 10px 14px;
                 cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.22);
                 transition: background .12s ease, transform .06s ease; }
        button:hover:not(:disabled) { background: #26262b; }
        button:active:not(:disabled) { transform: translateY(1px); }
        button:disabled { opacity: .65; cursor: default; }
        button:focus-visible { outline: 2px solid rgba(99,102,241,.6); outline-offset: 2px; }
        .toast { display: none; max-width: 268px; padding: 9px 11px;
                 background: #fff; color: #18181b; font-size: 12px; line-height: 1.45;
                 border: 1px solid #e6e6e9; border-radius: 10px;
                 box-shadow: 0 8px 24px rgba(24,24,27,.14); }
        .toast.show { display: block; animation: ff-in .14s ease; }
        @keyframes ff-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          button, .toast.show { transition: none; animation: none; }
        }
      </style>
      <div class="wrap">
        <div class="toast" role="status" aria-live="polite"></div>
        <button type="button">Fill form</button>
      </div>`;

    const btn = root.querySelector('button');
    const toast = root.querySelector('.toast');
    let hideTimer;

    const say = (text) => {
      toast.textContent = text;
      toast.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => toast.classList.remove('show'), 6000);
    };

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Filling...';
      try {
        const r = await fillForm();
        const left = r.unmatched.length;
        say(
          `Filled ${r.filled} of ${r.total} questions.` +
            (left ? ` ${left} still need a saved answer.` : ' Check everything before submitting.')
        );
      } catch (err) {
        say('Filling failed. Reload the page and try again.');
        console.error('[FormFlash]', err);
      } finally {
        btn.disabled = false;
        refreshButtonHint();
      }
    });

    ui = { host, root, btn, toast, say };
    document.documentElement.appendChild(host);
    return ui;
  }

  // Shows how many questions on the page already have a saved answer
  async function refreshButtonHint() {
    if (!ui || !ui.btn || ui.btn.disabled) return;
    try {
      const entries = await getEntries();
      const tasks = collectTasks();
      if (!tasks.length) {
        ui.btn.textContent = 'Fill form';
        return;
      }
      let matched = 0;
      for (const t of tasks) if (findAnswer(t.label, entries) != null) matched++;
      ui.btn.textContent = matched ? `Fill form (${matched})` : 'Fill form';
      ui.btn.title = matched
        ? `${matched} of ${tasks.length} questions have a saved answer`
        : 'No saved answers match this page';
    } catch {
      ui.btn.textContent = 'Fill form';
    }
  }

  async function init() {
    await loadSettings();
    if (!isFormPage()) return;
    ensureFlashStyle();
    const u = ensureUi();
    if (u) u.btn.hidden = !settings.showButton;
    observeForms();
    setTimeout(refreshButtonHint, 600);
  }

  init();
})();
