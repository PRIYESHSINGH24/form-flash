import test from 'node:test';
import assert from 'node:assert/strict';
import matcher from '../lib/matcher.js';

const {
  norm,
  squash,
  cleanLabel,
  findAnswer,
  pickOption,
  parseTokens,
  normalizeForInput,
} = matcher;

// normalizing text
test('norm lowercases, drops possessives and strips punctuation', () => {
  assert.equal(norm('E-mail *'), 'e mail');
  assert.equal(norm("Father's Name"), 'father name');
  assert.equal(norm('Student\u2019s name'), 'student name');
  assert.equal(norm('  Roll No.  '), 'roll no');
  assert.equal(norm(null), '');
  assert.equal(norm(undefined), '');
});

test('squash removes all spaces', () => {
  assert.equal(squash('E mail'), 'email');
  assert.equal(squash('E-mail address'), 'emailaddress');
});

test('cleanLabel strips numbering, required markers and asterisks', () => {
  assert.equal(cleanLabel('1. Email *'), 'Email');
  assert.equal(cleanLabel('* Full name'), 'Full name');
  assert.equal(cleanLabel('Phone   required question'), 'Phone');
  assert.equal(cleanLabel(' 2)   Team   name '), 'Team name');
});

// findAnswer
const entries = [
  { keys: ['=name'], value: 'Ada' },
  { keys: ['father name'], value: 'Bob' },
  { keys: ['email'], value: 'ada@example.com' },
  { keys: ['roll number', 'roll no'], value: '42' },
];

test('findAnswer matches whole words only', () => {
  assert.equal(findAnswer('Email address', entries), 'ada@example.com');
  assert.equal(findAnswer('Gmail', entries), null);
  assert.equal(findAnswer('names', entries), null);
});

test('findAnswer tolerates punctuation and spacing differences', () => {
  assert.equal(findAnswer('E mail', entries), 'ada@example.com');
  assert.equal(findAnswer('E-Mail:', entries), 'ada@example.com');
});

test('findAnswer =keyword requires an exact whole-question match', () => {
  assert.equal(findAnswer('Name', entries), 'Ada');
  assert.equal(findAnswer('NAME', entries), 'Ada');
  assert.equal(findAnswer('Full name', entries), null);
  assert.equal(findAnswer('Father name', entries), 'Bob');
  assert.equal(findAnswer("Father's Name", entries), 'Bob');
});

test('findAnswer longest keyword wins and null entries are safe', () => {
  assert.equal(findAnswer('Roll No.', entries), '42');
  assert.equal(findAnswer('', entries), null);
  assert.equal(findAnswer('Email', null), null);
  assert.equal(findAnswer('Email', [null, {}, { keys: 'gmail', value: 'x' }]), null);
});

// pickOption
test('pickOption prefers exact matches over partial ones', () => {
  const opts = [{ label: 'Engineering' }, { label: 'Engineering (Evening)' }];
  assert.equal(pickOption(opts, 'Engineering'), opts[0]);
  assert.equal(pickOption(opts, 'Evening'), opts[1]);
});

test('pickOption ignores punctuation and spacing differences', () => {
  const opts = [{ label: 'E-mail' }, { label: 'Phone' }];
  assert.equal(pickOption(opts, 'email'), opts[0]);
});

test('pickOption returns null when nothing fits', () => {
  const opts = [{ label: 'Java' }, { label: 'Python' }];
  assert.equal(pickOption(opts, 'Ruby'), null);
  assert.equal(pickOption(opts, ''), null);
  assert.equal(pickOption([], 'Java'), null);
});

test('pickOption handles numeric linear scales', () => {
  const opts = ['1', '2', '3', '4', '5'].map((label) => ({ label }));
  assert.equal(pickOption(opts, '3').label, '3');
  assert.equal(pickOption(opts, ' 5 ').label, '5');
});

// checkbox answers
test('parseTokens splits checkbox answers on commas, semicolons, pipes and newlines', () => {
  assert.deepEqual(parseTokens('Java, Python'), ['Java', 'Python']);
  assert.deepEqual(parseTokens('Java;Python|Go\nRust'), ['Java', 'Python', 'Go', 'Rust']);
  assert.deepEqual(parseTokens('   '), []);
  assert.deepEqual(parseTokens(null), []);
});

// input formatting
test('normalizeForInput formats dates for <input type="date">', () => {
  assert.equal(normalizeForInput('2026-10-04', 'date'), '2026-10-04');
  assert.equal(normalizeForInput('2026-1-5', 'date'), '2026-01-05');
  assert.equal(normalizeForInput('October 4, 2026', 'date'), '2026-10-04');
  assert.equal(normalizeForInput('31/12/2026', 'date'), '2026-12-31');
  assert.equal(normalizeForInput('12/31/2026', 'date'), '2026-12-31');
  assert.equal(normalizeForInput('not a date', 'date'), '');
});

test('normalizeForInput formats times for <input type="time">', () => {
  assert.equal(normalizeForInput('9:30 am', 'time'), '09:30');
  assert.equal(normalizeForInput('2:05 PM', 'time'), '14:05');
  assert.equal(normalizeForInput('14:05', 'time'), '14:05');
  assert.equal(normalizeForInput('9', 'time'), '09:00');
  assert.equal(normalizeForInput('25:00', 'time'), '');
  assert.equal(normalizeForInput('noon', 'time'), '');
});

test('normalizeForInput cleans numbers and leaves text alone', () => {
  assert.equal(normalizeForInput('1,234', 'number'), '1234');
  assert.equal(normalizeForInput('  9876543210 ', 'tel'), '9876543210');
  assert.equal(normalizeForInput('Hello', 'text'), 'Hello');
  assert.equal(normalizeForInput('twelve', 'number'), '');
  assert.equal(normalizeForInput('2026-3', 'month'), '2026-03');
});
