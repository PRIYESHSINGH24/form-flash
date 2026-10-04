'use strict';
const $ = (s) => document.querySelector(s);
// Same helpers the content script uses, so saved keys match what the page asks.
const { norm, upsertEntry, DEFAULT_ENTRIES } = globalThis.FormFlashMatcher;

const FORM_URL = /^https:\/\/(docs\.google\.com\/forms\/|forms\.office\.com\/|forms\.microsoft\.com\/|forms\.cloud\.microsoft\/)/;

const DEFAULT_SETTINGS = { autoFill: true, showButton: true, autoOpen: true };
const TYPE_LABELS = {
  text: 'text',
  contenteditable: 'rich text',
  radio: 'choice',
  checkbox: 'checkboxes',
  select: 'dropdown',
  dropdown: 'dropdown',
};

let entries = [];
let settings = { ...DEFAULT_SETTINGS };
let questions = [];
let tab = null;
let filterText = '';
let saveTimer;

// storage
async function loadEntries() {
  const { entries: saved } = await chrome.storage.local.get('entries');
  if (Array.isArray(saved)) {
    entries = saved;
  } else {
    entries = JSON.parse(JSON.stringify(DEFAULT_ENTRIES));
    await chrome.storage.local.set({ entries });
  }
}

// debounced write for typing in the Answers tab
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ entries }), 250);
}

function persistNow() {
  clearTimeout(saveTimer);
  return chrome.storage.local.set({ entries });
}

async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  $('#auto-fill').checked = settings.autoFill;
  $('#show-button').checked = settings.showButton;
  $('#auto-open').checked = settings.autoOpen;
}

function bindSwitch(id, key) {
  $(id).addEventListener('change', async (e) => {
    settings[key] = e.target.checked;
    await chrome.storage.local.set({ settings });
    setResult('Setting saved.', '');
  });
}

// result line
function setResult(text, type = '') {
  const el = $('#result');
  el.textContent = text;
  el.className = 'result' + (type ? ' result--' + type : '');
}

// talking to the page
async function send(msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // content script not there yet (tab open since before install or reload)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['lib/matcher.js', 'content.js'],
    });
    return await chrome.tabs.sendMessage(tab.id, msg);
  }
}

// questions detected on the page
async function refreshScan() {
  if (!tab || !tab.url || !FORM_URL.test(tab.url)) return;
  try {
    const res = await send({ type: 'FORMFLASH_SCAN' });
    questions = res && res.ok && Array.isArray(res.questions) ? res.questions : [];
  } catch (err) {
    questions = [];
    console.error(err);
  }
  renderScan();
}

// Forms render their questions late. Keep scanning for a few seconds so the
// panel does not sit on "nothing found" while the page is still loading.
let scanRetries = 0;
async function scanUntilFound() {
  await refreshScan();
  if (questions.length === 0 && scanRetries++ < 8) setTimeout(scanUntilFound, 900);
}

function renderScan() {
  const list = $('#questionList');
  list.textContent = '';
  const total = questions.length;
  const answered = questions.filter((q) => q.answer != null).length;
  const filled = questions.filter((q) => q.filled).length;
  $('#scan-count').textContent =
    `${answered} of ${total} answered` + (filled ? `, ${filled} filled on the page` : '');
  $('#bar-fill').style.width = total ? Math.round((answered / total) * 100) + '%' : '0%';
  $('#scan').hidden = false;
  if (!total) {
    const li = document.createElement('li');
    li.className = 'q-empty';
    li.textContent = 'No questions found yet. If the form is still loading, scan again.';
    list.append(li);
    return;
  }
  questions.forEach((q) => list.append(questionRow(q)));
}

function questionRow(q) {
  const state = q.filled ? 'filled' : q.answer != null ? 'saved' : 'missing';
  const li = document.createElement('li');
  li.className = 'q-row q-row--' + state;

  const head = document.createElement('div');
  head.className = 'q-head';
  const label = document.createElement('span');
  label.className = 'q-label';
  label.textContent = q.label;
  const chip = document.createElement('span');
  chip.className = 'q-chip q-chip--' + state;
  chip.textContent = state;
  head.append(label, chip);
  li.append(head);

  const meta = document.createElement('div');
  meta.className = 'q-meta';
  const type = document.createElement('span');
  type.className = 'type-chip';
  type.textContent = TYPE_LABELS[q.type] || q.type;
  meta.append(type);
  if (q.answer != null) {
    const value = document.createElement('span');
    value.className = 'q-answer';
    value.textContent = q.answer;
    value.title = q.answer;
    meta.append(value);
  }
  li.append(meta);

  if (q.answer == null) {
    // no saved answer yet: type or pick one and save it
    const options = Array.isArray(q.options) ? q.options : [];
    const row = document.createElement('div');
    row.className = 'q-save';
    let field;
    if ((q.type === 'radio' || q.type === 'select' || q.type === 'dropdown') && options.length) {
      field = document.createElement('select');
      const first = document.createElement('option');
      first.value = '';
      first.textContent = 'Pick an answer';
      field.append(first);
      options.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        field.append(opt);
      });
    } else {
      field = document.createElement('input');
      field.type = 'text';
      field.placeholder = q.type === 'checkbox' ? 'choices, comma separated' : 'Type the answer';
    }
    field.className = 'q-input';
    field.setAttribute('aria-label', 'Answer for ' + q.label);
    const save = document.createElement('button');
    save.className = 'btn-small';
    save.textContent = 'Save';
    const run = () => saveAnswerFor(q, field, save);
    save.addEventListener('click', run);
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    row.append(field, save);
    li.append(row);
  } else {
    // saved answer: fill just this one
    const actions = document.createElement('div');
    actions.className = 'q-actions';
    const fill = document.createElement('button');
    fill.className = 'btn-ghost';
    fill.textContent = q.filled ? 'Fill again' : 'Fill';
    fill.addEventListener('click', () => fillQuestion(q, fill));
    actions.append(fill);
    li.append(actions);
  }
  return li;
}

// Save the answer for a detected question, then fill it on the page.
async function saveAnswerFor(q, field, btn) {
  const value = field.value.trim();
  if (!value) {
    field.focus();
    setResult('Type or pick an answer first.', 'warn');
    return;
  }
  btn.disabled = true;
  try {
    entries = upsertEntry(entries, q.label, value);
    await persistNow();
    q.answer = value;
    renderRows();
    const res = await send({ type: 'FORMFLASH_FILL_ONE', label: q.label });
    if (res && res.ok && res.filled) q.filled = true;
    setResult('Saved. This question fills itself from now on.', 'ok');
  } catch (err) {
    setResult('Could not save that answer.', 'err');
    console.error(err);
  }
  renderScan();
}

async function fillQuestion(q, btn) {
  btn.disabled = true;
  try {
    const res = await send({ type: 'FORMFLASH_FILL_ONE', label: q.label });
    if (res && res.ok && res.filled) {
      q.filled = true;
      renderScan();
      setResult(`Filled "${q.label}".`, 'ok');
    } else if (res && res.reason === 'no-answer') {
      setResult('No saved answer for that one yet.', 'warn');
    } else {
      setResult('Could not fill that question.', 'err');
    }
  } catch (err) {
    setResult('Could not reach the page. Reload the form and try again.', 'err');
    console.error(err);
  }
  btn.disabled = false;
}

// answer rows
function renderRows() {
  const list = $('#rows');
  list.textContent = '';
  const q = norm(filterText);
  const visible = entries.filter(
    (e) => !q || (e.keys || []).some((k) => norm(k).includes(q)) || norm(e.value).includes(q)
  );
  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = q ? 'No matches.' : 'No saved answers yet.';
    list.append(li);
    return;
  }
  visible.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'answer-row';

    const keys = document.createElement('input');
    keys.type = 'text';
    keys.className = 'answer-field answer-field--mono';
    keys.placeholder = 'keywords, comma separated';
    keys.setAttribute('aria-label', 'Keywords');
    keys.value = (entry.keys || []).join(', ');
    keys.addEventListener('input', () => {
      entry.keys = keys.value.split(',').map((k) => k.trim()).filter(Boolean);
      persist();
    });

    const val = document.createElement('textarea');
    val.rows = 1;
    val.className = 'answer-field';
    val.placeholder = 'your answer';
    val.setAttribute('aria-label', 'Answer');
    val.value = entry.value || '';
    val.addEventListener('input', () => {
      entry.value = val.value;
      val.style.height = 'auto';
      val.style.height = val.scrollHeight + 'px';
      persist();
    });

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', () => {
      entries.splice(entries.indexOf(entry), 1);
      persist();
      renderRows();
      refreshScan();
    });

    li.append(keys, val, del);
    list.append(li);
    // size multi-line answers once the row is in the page
    val.style.height = 'auto';
    val.style.height = val.scrollHeight + 'px';
  });
}

$('#search').addEventListener('input', (e) => {
  filterText = e.target.value;
  renderRows();
});

$('#add').addEventListener('click', () => {
  entries.unshift({ keys: [], value: '' });
  persist();
  filterText = '';
  $('#search').value = '';
  renderRows();
  setTimeout(() => {
    const first = document.querySelector('#rows .answer-field');
    if (first) first.focus();
  }, 50);
});

// tabs
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab-body').forEach((b) => b.classList.add('hidden'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// import and export
$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ app: 'formflash', v: 1, entries }, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'formflash-answers.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import').addEventListener('click', () => $('#file').click());

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(incoming)) throw new Error();
    const clean = incoming
      .filter((x) => x && Array.isArray(x.keys))
      .map((x) => ({ keys: x.keys.map(String), value: String(x.value ?? '') }));
    if (!confirm(`Replace ${entries.length} saved answers with ${clean.length} from this file?`)) return;
    entries = clean;
    await persistNow();
    renderRows();
    refreshScan();
    setResult(`Imported ${clean.length} answers.`, 'ok');
  } catch {
    setResult('That file is not a FormFlash export.', 'err');
  }
});

$('#clear-all').addEventListener('click', async () => {
  if (!confirm(`Delete all ${entries.length} saved answers? This cannot be undone.`)) return;
  entries = [];
  await persistNow();
  renderRows();
  refreshScan();
  setResult('All answers deleted.', 'warn');
});

// fill the whole form
$('#fill').addEventListener('click', async () => {
  const btn = $('#fill');
  btn.disabled = true;
  btn.querySelector('.fill-label').textContent = 'Filling...';
  setResult('');
  try {
    const res = await send({ type: 'FORMFLASH_FILL' });
    if (!res || !res.ok) throw new Error(res && res.error);
    const { filled, total, unmatched } = res.report;
    if (!total) {
      setResult('No questions found on this page.', 'warn');
    } else if (unmatched.length) {
      setResult(`Filled ${filled} of ${total}. ${unmatched.length} still need an answer.`, 'warn');
    } else {
      setResult(`Filled all ${total} questions. Check them before submitting.`, 'ok');
    }
    await refreshScan();
  } catch (err) {
    setResult('Could not fill the form. Reload the page and try again.', 'err');
    console.error(err);
  } finally {
    btn.disabled = !tab || !tab.url || !FORM_URL.test(tab.url);
    btn.querySelector('.fill-label').textContent = 'Fill this form';
  }
});

$('#refresh').addEventListener('click', async () => {
  await refreshScan();
  setResult(`Found ${questions.length} question${questions.length === 1 ? '' : 's'}.`, '');
});

// answers saved from the on-page panel show up here too
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.entries) return;
  const next = changes.entries.newValue;
  if (!Array.isArray(next) || JSON.stringify(next) === JSON.stringify(entries)) return;
  if (document.activeElement && document.activeElement.closest('#rows')) return; // mid-edit
  entries = next;
  renderRows();
  refreshScan();
});

// start
(async function start() {
  await loadEntries();
  await loadSettings();
  bindSwitch('#auto-fill', 'autoFill');
  bindSwitch('#show-button', 'showButton');
  bindSwitch('#auto-open', 'autoOpen');
  renderRows();

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onForm = tab && tab.url && FORM_URL.test(tab.url);

  const badge = $('#tab-badge');
  if (onForm) {
    $('#tab-badge-text').textContent = 'on a form';
    badge.className = 'status status--on';
  } else {
    $('#tab-badge-text').textContent = 'no form';
    badge.className = 'status';
  }

  $('#fill').disabled = !onForm;
  $('#refresh').disabled = !onForm;

  if (onForm) {
    await scanUntilFound();
  } else {
    $('#scan').hidden = true;
    setResult('Open a Google or Microsoft Form to use this.', '');
  }
})();
