'use strict';
const $ = (s) => document.querySelector(s);
// Same normalization the content script uses, so saved keys match the page.
const { norm } = globalThis.FormFlashMatcher;

const FORM_URL = /^https:\/\/(docs\.google\.com\/forms\/|forms\.office\.com\/|forms\.microsoft\.com\/|forms\.cloud\.microsoft\/)/;

const DEFAULTS = [
  {keys:['=name','full name','your name','student name','candidate name','participant name'],value:''},
  {keys:['email','e mail','mail id','email address'],value:''},
  {keys:['phone','mobile','contact number','whatsapp'],value:''},
  {keys:['college','university','institute','institution'],value:''},
  {keys:['roll number','roll no','enrollment','enrolment','registration number','student id'],value:''},
  {keys:['branch','department','course','program'],value:''},
  {keys:['cgpa','gpa'],value:''},
  {keys:['linkedin'],value:''},
  {keys:['github'],value:''},
  {keys:['city','current city'],value:''},
];

const DEFAULT_SETTINGS = { autoFill: true, showButton: true };
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
  entries = Array.isArray(saved) ? saved : JSON.parse(JSON.stringify(DEFAULTS));
  if (!Array.isArray(saved)) await chrome.storage.local.set({ entries });
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ entries }), 250);
}

async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  $('#auto-fill').checked = settings.autoFill;
  $('#show-button').checked = settings.showButton;
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

// Re-run the scan a few times while the form is still lazy-loading. Each run
// expands the list instead of blanking it, so the panel never stares at an empty
// screen while Google/Microsoft finish rendering the questions.
let scanRetryTimer = null;
async function watchScan() {
  await refreshScan();
  if (questions.length === 0) {
    clearTimeout(scanRetryTimer);
    scanRetryTimer = setTimeout(watchScan, 900);
  }
}

// Clear any partial scan when the user re-scans — an empty list is the only time
// the panel should be blank (with a prompt to try again) so the user knows what to
// do next instead of looking for something that was never there.
function clearScanMarkers() {
  $('#scan-count').textContent = '0 of 0 answered';
  $('#bar-fill').style.width = '0%';
}

// The popup itself is the retry. If the form's still loading, keep re-scanning
// instead of showing a dead panel.
async function startScan() {
  await refreshScan();
  if (questions.length === 0) {
    clearScanMarkers();
    $('#scan').hidden = false;
    const empty = $('#scan').querySelector('.q-empty');
    if (empty) empty.textContent = 'Scanning this form... If it keeps showing an empty list, refresh the page and rescan.';
  } else {
    clearScanMarkers();
    $('#scan').hidden = false;
  }
}

// Fills a question's answer from a select or text field, then moves to the next
// question when the user presses Enter or Escape.
function onQuestionKeydown(e) {
'use strict';
const $ = (s) => document.querySelector(s);
// Same normalization the content script uses, so saved keys match the page.
const { norm } = globalThis.FormFlashMatcher;

const FORM_URL = /^https:\/\/(docs\.google\.com\/forms\/|forms\.office\.com\/|forms\.microsoft\.com\/|forms\.cloud\.microsoft\/)/;

const DEFAULTS = [
  {keys:['=name','full name','your name','student name','candidate name','participant name'],value:''},
  {keys:['email','e mail','mail id','email address'],value:''},
  {keys:['phone','mobile','contact number','whatsapp'],value:''},
  {keys:['college','university','institute','institution'],value:''},
  {keys:['roll number','roll no','enrollment','enrolment','registration number','student id'],value:''},
  {keys:['branch','department','course','program'],value:''},
  {keys:['cgpa','gpa'],value:''},
  {keys:['linkedin'],value:''},
  {keys:['github'],value:''},
  {keys:['city','current city'],value:''},
];

const DEFAULT_SETTINGS = { autoFill: true, showButton: true };
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
  entries = Array.isArray(saved) ? saved : JSON.parse(JSON.stringify(DEFAULTS));
  if (!Array.isArray(saved)) await chrome.storage.local.set({ entries });
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ entries }), 250);
}

async function loadSettings() {
  const { settings: saved } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  $('#auto-fill').checked = settings.autoFill;
  $('#show-button').checked = settings.showButton;
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

let scanRetryTimer = null;
async function watchScan() {
  await refreshScan();
  if (questions.length === 0) {
    clearTimeout(scanRetryTimer);
    scanRetryTimer = setTimeout(watchScan, 900);
  }
}

// Clear any partial scan when the user re-scans — an empty list is the only time
// the panel should be blank (with a prompt to try again) so the user knows what to
// do next instead of looking for something that was never there.
function clearScanMarkers() {
      if (e.keyCode === KEY.ENTER) {
        if (field && field.value.trim()) {
          if (!field.closest('.q-save')) saveFieldValue(field);
          else saveArrowAnswer(e.currentTarget, field, select);
        } else if (select && select.value) {
          saveArrowAnswer(e.currentTarget, field, select, rows, next);
        } else {
          e.currentTarget.querySelector('.q-save input')?.focus();
        }
      } else {
        if (field && field.value.trim()) {
          field.value = '';
          if (!field.closest('.q-save')) saveFieldValue(field);
          else saveArrowAnswer(e.currentTarget, field, select, rows, next);
        } else {
          e.currentTarget.querySelector('.q-save input')?.focus();
        }
      }
      break;
  }
  if (next >= 0) rows[next]?.focus();
}

// Kept locally so the arrows keep working after the list re-renders.
function saveFieldValue(focusEl) {
  const li = focusEl.closest('.q-row');
  if (!li) return;
  const row = li.__q;
  const field = focusEl;
  const select = li.querySelector('select');
  saveAnswerFor(row, field);
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

  questions.forEach((q, i) => list.append(questionRow(q, i === 0)));
}

function questionRow(q, active) {
  const state = q.filled ? 'filled' : q.answer != null ? 'saved' : 'missing';
  const li = document.createElement('li');
  li.className = 'q-row q-row--' + state;
  if (active) {
    li.setAttribute('tabindex', '0');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'true');
    li.addEventListener('keydown', onQuestionKeydown);
  }

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
    save.addEventListener('click', () => saveAnswerFor(q, field));

    row.append(field, save);
    li.append(row);
  } else {
    const actions = document.createElement('div');
    actions.className = 'q-actions';
    const fill = document.createElement('button');
    fill.className = 'btn-ghost';
    fill.textContent = q.filled ? 'Fill again' : 'Fill';
    fill.addEventListener('click', () => fillQuestion(q, fill));

    // Tab/Shift+Tab moves through the whole list; the row itself handles arrows.
    li.addEventListener('focus', () => fill.classList.add('focus-visible'));
    li.addEventListener('blur', () => fill.classList.remove('focus-visible'));
    actions.append(fill);
    li.append(actions);
  }

  return li;
}

const KEY = { ARROW_DOWN: 40, ARROW_UP: 38, ENTER: 13, ESCAPE: 27, HOME: 36, END: 35 };

// Arrowkeys move between the active question rows; Enter saves the answer on
// the focused row, Escape clears it and leaves the row for the next one.
function onQuestionKeydown(e) {
  const list = document.getElementById('questionList');
  const rows = [...list.querySelectorAll('.q-row:not([tabindex="-1"])')];
  const i = rows.indexOf(e.currentTarget);
  if (i < 0) return;

  let next = -1;
  switch (e.keyCode) {
    case KEY.ARROW_DOWN:
      next = i + 1 < rows.length ? i + 1 : 0;
      break;
    case KEY.ARROW_UP:
      next = i - 1 >= 0 ? i - 1 : rows.length - 1;
      break;
    case KEY.HOME:
      next = 0;
      break;
    case KEY.END:
      next = rows.length - 1;
      break;
    case KEY.ENTER:
      e.preventDefault();
      const field = e.currentTarget.querySelector('.q-input');
      const select = e.currentTarget.querySelector('select');
      if (field && field.value.trim()) {
        if (!field.closest('.q-save')) saveFieldValue(field);
        else saveArrowAnswer(e.currentTarget, field, select, rows, next);
      } else if (select && select.value) {
        saveArrowAnswer(e.currentTarget, field, select, rows, next);
      } else if (e.currentTarget.querySelector('.q-save input') || e.currentTarget.querySelector('.q-save select')) {
        e.currentTarget.querySelector('.q-save input')?.focus();
      }
      return;
    case KEY.ESCAPE:
      e.preventDefault();
      const field2 = e.currentTarget.querySelector('.q-input');
      const select2 = e.currentTarget.querySelector('select');
      if (field2 && field2.value.trim()) {
        field2.value = '';
        if (!field2.closest('.q-save')) saveFieldValue(field2);
        else saveArrowAnswer(e.currentTarget, field2, select2, rows, next);
      } else {
        e.currentTarget.querySelector('.q-save input')?.focus();
      }
      return;
    default:
      return;
  }

  e.preventDefault();
  rows[next]?.focus();
}



async function saveArrowAnswer(row, field, select) {
  field.value = '';
  if (select && select.value) {
    const value = select.value;
    select.value = '';
    field.value = value;
  }
  saveAnswerFor(row.__q, field);
}

// Kept locally so the arrows work even after the list re-renders.
function saveFieldValue(focusEl) {
  const li = focusEl.closest('.q-row');
  if (!li) return;
  const row = li.__q;
  const field = focusEl;
  const select = li.querySelector('select');
  saveAnswerFor(row, field);
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
}

// answer rows
function renderRows() {
  const list = $('#rows');
  list.textContent = '';
  const q = norm(filterText);
  const visible = entries.filter(
    (e) => !q || e.keys.some((k) => norm(k).includes(q)) || norm(e.value).includes(q)
  );

  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = q ? 'No matches.' : 'No saved answers yet.';
    list.append(li);
    return;
  }

  visible.forEach((entry) => {
    const i = entries.indexOf(entry);
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
      persist();
    });
    val.addEventListener('input', () => {
      val.style.height = 'auto';
      val.style.height = val.scrollHeight + 'px';
    });

    const del = document.createElement('button');
    del.className = 'del-btn';
    del.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', () => {
      entries.splice(i, 1);
      persist();
      renderRows();
    });

    li.append(keys, val, del);
    list.append(li);
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
    await chrome.storage.local.set({ entries });
    renderRows();
    setResult(`Imported ${clean.length} answers.`, 'ok');
  } catch {
    setResult('That file is not a FormFlash export.', 'err');
  }
});

$('#clear-all').addEventListener('click', async () => {
  if (!confirm(`Delete all ${entries.length} saved answers? This cannot be undone.`)) return;
  entries = [];
  await chrome.storage.local.set({ entries });
  renderRows();
  refreshScan();
  setResult('All answers deleted.', 'warn');
});

// fill
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

// start
(async function start() {
  await loadEntries();
  await loadSettings();
  bindSwitch('#auto-fill', 'autoFill');
  bindSwitch('#show-button', 'showButton');
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
    await refreshScan();
  } else {
    $('#scan').hidden = true;
    setResult('Open a Google or Microsoft Form to use this.', '');
  }
})();
