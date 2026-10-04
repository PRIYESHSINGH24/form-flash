/* Matching and input formatting helpers shared by the content script, the popup
 * and the tests. No DOM access and no chrome APIs here, so it runs in plain node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FormFlashMatcher = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  // lowercase, drop possessives, strip punctuation:
  // "E-mail *" -> "e mail", "Father's Name" -> "father name"
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/['\u2019]s\b/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function squash(s) {
    return norm(s).replace(/ /g, '');
  }

  function cleanLabel(text) {
    return String(text == null ? '' : text)
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/required question/gi, '')
      .trim()
      .replace(/^\d+\s*[.)]\s*/, '')
      .replace(/\s*\*+\s*$/, '')
      .replace(/^\*+\s*/, '')
      .trim();
  }

  // Longest matching keyword wins. A keyword starting with "=" must match the
  // whole question text (e.g. "=name" matches "Name" but not "Father's name").
  // findEntry returns the best matching entry (or null); findAnswer returns its
  // value. findEntry also sees entries whose answer is still empty, which is how
  // a saved answer lands in an existing template row instead of a duplicate.
  function findEntry(label, entries) {
    const L = norm(label);
    if (!L) return null;
    const padded = ' ' + L + ' ';
    const packed = squash(L);
    let best = null;
    let bestScore = 0;
    for (const e of entries || []) {
      if (!e || !Array.isArray(e.keys)) continue;
      for (const raw of e.keys) {
        const rawStr = String(raw);
        let score = 0;
        if (rawStr.startsWith('=')) {
          const k = norm(rawStr.slice(1));
          if (k && (L === k || packed === squash(k))) score = 1000 + k.length;
        } else {
          const k = norm(rawStr);
          if (!k) continue;
          // whole-word match, or the same phrase once punctuation/spacing is gone
          if (padded.includes(' ' + k + ' ')) score = k.length;
          else if (packed === squash(k)) score = 500 + k.length;
        }
        if (score > bestScore) {
          best = e;
          bestScore = score;
        }
      }
    }
    return best;
  }

  function findAnswer(label, entries) {
    const best = findEntry(label, entries);
    return best ? best.value : null;
  }

  // The keyword to store when the user saves an answer for a question.
  // Short labels ("Name", "Email") would match far too many questions as a plain
  // keyword ("name" also matches "Father's name"), so they are saved as exact
  // "=label" keywords. Longer questions are specific enough to stay plain.
  function keyForLabel(label) {
    const clean = cleanLabel(label).replace(/[?:]+\s*$/, '').trim();
    if (!clean) return '';
    const words = norm(clean).split(' ').filter(Boolean);
    return words.length <= 2 ? '=' + clean : clean;
  }

  // Save an answer for a question. If an existing row already matches the
  // question (typically a template row with an empty answer), that row gets the
  // value; otherwise a new row goes on top. Returns a new array, never mutates.
  function upsertEntry(entries, label, value) {
    const list = Array.isArray(entries) ? entries.map((e) => ({ keys: [...e.keys], value: e.value })) : [];
    const text = String(value == null ? '' : value).trim();
    const key = keyForLabel(label);
    if (!text || !key) return list;
    const hit = findEntry(label, list);
    if (hit) {
      hit.value = text;
      return list;
    }
    list.unshift({ keys: [key], value: text });
    return list;
  }

  // Choose the option that best fits the saved answer. `options` are objects
  // with a `.label`. Exact matches (ignoring punctuation/spacing) beat partial
  // word matches; null means "no safe match".
  function pickOption(options, answer) {
    const A = norm(answer);
    if (!A) return null;
    const paddedA = ' ' + A + ' ';
    let best = null;
    let bestScore = 0;
    for (const o of options || []) {
      const L = norm(o && o.label);
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

  // Checkbox answers: "Java, Python" / "Java; Python" / "Java | Python" / newlines
  function parseTokens(answer) {
    return String(answer == null ? '' : answer)
      .split(/[,;|\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // Starter rows: keywords people see on most forms, answers left empty.
  const DEFAULT_ENTRIES = [
    { keys: ['=name', 'full name', 'your name', 'student name', 'candidate name', 'participant name'], value: '' },
    { keys: ['email', 'e mail', 'mail id', 'email address'], value: '' },
    { keys: ['phone', 'mobile', 'contact number', 'whatsapp'], value: '' },
    { keys: ['college', 'university', 'institute', 'institution'], value: '' },
    { keys: ['roll number', 'roll no', 'enrollment', 'enrolment', 'registration number', 'student id'], value: '' },
    { keys: ['branch', 'department', 'course', 'program'], value: '' },
    { keys: ['cgpa', 'gpa'], value: '' },
    { keys: ['linkedin'], value: '' },
    { keys: ['github'], value: '' },
    { keys: ['city', 'current city'], value: '' },
  ];

  // Inverse of parseTokens: list picked options as one comma separated answer.
  function joinTokens(list) {
    return (list || [])
      .map((t) => String(t).trim())
      .filter(Boolean)
      .join(', ');
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  // Accept the formats people actually type, emit what <input type="date"> wants.
  function parseDateInput(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return '';
    if (/^today$/i.test(s)) return isoDate(new Date());
    if (/^tomorrow$/i.test(s)) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return isoDate(d);
    }
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
      const [y, m, d] = s.split('-').map(Number);
      if (m < 1 || m > 12 || d < 1 || d > 31) return '';
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
    const dmy = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (dmy) {
      const a = +dmy[1];
      const b = +dmy[2];
      const y = +dmy[3];
      let day;
      let month;
      if (a > 12 && b <= 12) [day, month] = [a, b]; // 31/12/2026 -> day first
      else if (b > 12 && a <= 12) [month, day] = [a, b]; // 12/31/2026 -> month first
      else [month, day] = [a, b]; // ambiguous -> month/day, like the browser does
      if (month < 1 || month > 12 || day < 1 || day > 31) return '';
      return `${y}-${pad2(month)}-${pad2(day)}`;
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? '' : isoDate(new Date(t));
  }

  // "9:30 am" / "2:05 PM" / "14:05" / "9" -> what <input type="time"> wants
  function parseTimeInput(value) {
    const s = String(value == null ? '' : value).trim().toLowerCase();
    if (!s) return '';
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) return '';
    let h = +m[1];
    const min = m[2] ? +m[2] : 0;
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return '';
    return `${pad2(h)}:${pad2(min)}`;
  }

  // Put a saved answer into the shape the target input expects. Returns '' when
  // the answer cannot be expressed (better to skip than to write garbage).
  function normalizeForInput(value, type) {
    const t = String(type || 'text').toLowerCase();
    const raw = String(value == null ? '' : value).trim();
    switch (t) {
      case 'date':
        return parseDateInput(raw);
      case 'time':
        return parseTimeInput(raw);
      case 'month': {
        const m = raw.match(/^(\d{4})-(\d{1,2})$/);
        if (!m || +m[2] < 1 || +m[2] > 12) return '';
        return `${m[1]}-${pad2(+m[2])}`;
      }
      case 'number':
      case 'range': {
        const n = raw.replace(/[\s,]/g, '');
        return /^-?\d+(?:\.\d+)?$/.test(n) ? n : '';
      }
      default:
        return raw;
    }
  }

  return {
    norm,
    squash,
    cleanLabel,
    findEntry,
    findAnswer,
    keyForLabel,
    upsertEntry,
    DEFAULT_ENTRIES,
    pickOption,
    parseTokens,
    joinTokens,
    parseDateInput,
    parseTimeInput,
    normalizeForInput,
  };
});
