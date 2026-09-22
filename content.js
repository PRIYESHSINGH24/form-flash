/* FormFlash content script
 * Runs on Google Forms / Microsoft Forms pages.
 * - Reads saved answers from chrome.storage.local ("entries")
 * - Finds every question, matches its text against your keywords, fills it
 * - Never submits the form and never overwrites text you already typed
 */
(() => {
  'use strict';
  if (window.__formflashLoaded) return;
  window.__formflashLoaded = true;

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // lowercase, strip punctuation: "E-mail *" -> "e mail"
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();

  const squash = (s) => norm(s).replace(/ /g, '');

  function cleanLabel(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/required question/gi, '')
      .replace(/^\d+\s*[.)]\s*/, '')
      .replace(/\s*\*+\s*$/, '')
      .replace(/^\*+\s*/, '')
      .trim();
  }

  function isFormPage() {
    if (location.hostname === 'docs.google.com') {
      return /\/forms\/.+\/viewform/.test(location.pathname);
    }
    return !/design/i.test(location.href);
  }

  // ---------- storage ----------
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

  // ---------- matching ----------
  // Longest matching keyword wins. A keyword starting with "=" must match the
  // whole question text (e.g. "=name" matches "Name" but not "Father's name").
  function findAnswer(label, entries) {
    const L = norm(label);
    const padded = ' ' + L + ' ';
    let best = null;
    let bestScore = 0;
    for (const e of entries) {
      for (const raw of e.keys) {
        let score = 0;
        if (raw.startsWith('=')) {
          const k = norm(raw.slice(1));
          if (k && L === k) score = 1000 + k.length;
        } else {
          const k = norm(raw);
          if (k && padded.includes(' ' + k + ' ')) score = k.length;
        }
        if (score > bestScore) {
          best = e;
          bestScore = score;
        }
      }
    }
    return best ? best.value : null;
  }

  // choose the option that best fits the saved answer
  function pickOption(options, answer) {
    const A = norm(answer);
    if (!A) return null;
    const paddedA = ' ' + A + ' ';
    let best = null;
    let bestScore = 0;
    for (const o of options) {
      const L = norm(o.label);
      if (!L) continue;
      let s = 0;
      if (L === A || squash(L) === squash(A)) s = 3;
      else if (paddedA.includes(' ' + L + ' ') || (' ' + L + ' ').includes(paddedA)) s = 2;
      if (s > bestScore) {
        best = o;
        bestScore = s;
      }
    }
    return best;
  }

  // ---------- DOM: find questions ----------
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

  function toOptions(nodes) {
    return nodes
      .filter((n) => n.getAttribute('data-value') !== OTHER)
      .map((n) => ({ el: n, label: optionLabel(n).trim() }))
      .filter((o) => o.label);
  }

  function detect(el) {
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

    const combo = el.querySelector('[role="combobox"]');
    if (combo) return { type: 'dropdown', el: combo, options: dropdownOptions(el) };

    return null; // file upload, section header, image, etc.
  }

  const SKIP_INPUT_TYPES = ['hidden', 'radio', 'checkbox', 'button', 'submit', 'reset', 'file', 'image'];

  function dropdownOptions(scope) {
    return [...scope.querySelectorAll('[role="option"]')]
      .map((o) => ({ el: o, label: (o.getAttribute('data-value') || o.textContent || '').trim() }))
      .filter((o) => o.label);
  }

  // ---------- DOM: fill ----------
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

  async function fillDropdown(box, item, answer) {
    realClick(box);
    await sleep(300);
    let opts = dropdownOptions(item);
    if (!opts.length) opts = dropdownOptions(document);
    const best = pickOption(opts, answer);
    if (best) {
      realClick(best.el);
      await sleep(200);
      return true;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  }

  async function fillControl(q, ctl, answer) {
    switch (ctl.type) {
      case 'text': {
        if (ctl.el.value && ctl.el.value.trim() !== '') return true; // keep what the user typed
        setText(ctl.el, answer);
        return true;
      }
      case 'radio': {
        const best = pickOption(ctl.options, answer);
        if (!best) return false;
        if (!isChecked(best.el)) realClick(best.el);
        return true;
      }
      case 'checkbox': {
        const tokens = answer.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
        let hit = 0;
        for (const t of tokens) {
          const best = pickOption(ctl.options, t);
          if (best) {
            hit++;
            if (!isChecked(best.el)) realClick(best.el);
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
        return true;
      }
      case 'dropdown':
        return fillDropdown(ctl.el, q.el, answer);
      default:
        return false;
    }
  }

  // ---------- main ----------
  async function fillForm() {
    const entries = await getEntries();
    const questions = getQuestions();
    const report = { filled: 0, total: 0, unmatched: [] };

    for (const q of questions) {
      const ctl = detect(q.el);
      if (!ctl) continue;
      report.total++;

      const answer = findAnswer(q.label, entries);
      let ok = false;
      if (answer != null) {
        try {
          ok = await fillControl(q, ctl, answer);
        } catch (err) {
          console.warn('[FormFlash] could not fill:', q.label, err);
        }
      }
      if (ok) {
        report.filled++;
      } else if (!report.unmatched.some((u) => u.label === q.label)) {
        report.unmatched.push({
          label: q.label,
          type: ctl.type,
          options: (ctl.options || []).map((o) => o.label).slice(0, 30),
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
      },
    });
    return report;
  }

  // ---------- popup <-> page messaging ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'FORMFLASH_PING') {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'FORMFLASH_FILL') {
      fillForm()
        .then((report) => sendResponse({ ok: true, report }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // keep the channel open for the async reply
    }
  });

  // ---------- floating "Fill form" button (one click, right on the page) ----------
  function mountButton() {
    if (!isFormPage() || document.getElementById('formflash-host')) return;

    const host = document.createElement('div');
    host.id = 'formflash-host';
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .wrap { display:flex; flex-direction:column; align-items:flex-end; gap:8px;
                font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif; }
        button { font:600 12.5px/1 inherit; cursor:pointer;
                 padding:11px 18px; border-radius:99px;
                 background:rgba(255,255,255,0.10);
                 color:rgba(255,255,255,0.92);
                 border:1px solid rgba(255,255,255,0.20);
                 backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
                 box-shadow:0 8px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.12);
                 transition:transform 120ms cubic-bezier(.22,1,.36,1),
                            background 0.15s, border-color 0.15s, box-shadow 0.15s; }
        button:hover { background:rgba(255,255,255,0.16); border-color:rgba(255,255,255,0.35);
                 transform:translateY(-2px);
                 box-shadow:0 12px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.18); }
        button:active { transform:translateY(0px); }
        button:focus-visible { outline:1.5px solid rgba(255,255,255,0.5); outline-offset:3px; }
        button[disabled] { opacity:.4; cursor:progress; }
        .toast { background:rgba(10,12,20,0.85); color:rgba(255,255,255,0.8);
                 padding:10px 14px; border-radius:12px;
                 font-size:12px; line-height:1.5; max-width:270px; display:none;
                 border:1px solid rgba(255,255,255,0.10);
                 backdrop-filter:blur(20px); -webkit-backdrop-filter:blur(20px);
                 box-shadow:0 12px 40px rgba(0,0,0,0.6); }
        .toast.show { display:block; }
        @media (prefers-reduced-motion: reduce) { button { transition:none; } }
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
          `Filled ${r.filled} of ${r.total}.` +
            (left ? ` ${left} need your answer - open the FormFlash popup to add them.` : ' Check it, then submit.')
        );
      } catch (err) {
        say('Something broke while filling. Try again or reload the form.');
        console.error('[FormFlash]', err);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Fill form';
      }
    });

    document.documentElement.appendChild(host);
  }

  mountButton();
})();
