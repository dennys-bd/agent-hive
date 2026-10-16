import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Condition, type ConditionTerm, chainMarkers, formatCondition, parseCondition } from '../src/template-condition.js';

// Liquid conditions as data (#311): parsed from a marker's text, written back to it, and the marker lines of a chain.
const one = (term: ConditionTerm): Condition => ({ connective: 'and', terms: [term] });

test('each operator round-trips between text and condition (#311)', () => {
  const cases: [string, Condition][] = [
    ['delivery == "stacked"', one({ variable: 'delivery', op: 'is', value: 'stacked' })],
    ['delivery != "single"', one({ variable: 'delivery', op: 'isNot', value: 'single' })],
    ['labels contains "ui"', one({ variable: 'labels', op: 'contains', value: 'ui' })],
    ['testCommand', one({ variable: 'testCommand', op: 'hasValue' })],
    ['testCommand == blank', one({ variable: 'testCommand', op: 'isBlank' })],
    ['dryRun == false', one({ variable: 'dryRun', op: 'isNo' })],
    ['reviewer == nil', one({ variable: 'reviewer', op: 'is', value: null })],
    ['strict == true', one({ variable: 'strict', op: 'is', value: true })],
  ];
  for (const [text, condition] of cases) {
    assert.deepEqual(parseCondition(text), condition, text);
    assert.equal(formatCondition(condition), text, text);
  }
});

test('"is one of" is an or of is terms, an and of two terms round-trips, and a connective inside a value is not one (#311)', () => {
  const oneOf: Condition = {
    connective: 'or',
    terms: [{ variable: 'delivery', op: 'is', value: 'stacked' }, { variable: 'delivery', op: 'is', value: 'single' }],
  };
  assert.equal(formatCondition(oneOf), 'delivery == "stacked" or delivery == "single"');
  assert.deepEqual(parseCondition(formatCondition(oneOf)), oneOf);
  const both: Condition = {
    connective: 'and',
    terms: [{ variable: 'dryRun', op: 'hasValue' }, { variable: 'delivery', op: 'isNot', value: 'single' }],
  };
  assert.equal(formatCondition(both), 'dryRun and delivery != "single"');
  assert.deepEqual(parseCondition(formatCondition(both)), both);
  assert.deepEqual(parseCondition('note == "salt and pepper"'), one({ variable: 'note', op: 'is', value: 'salt and pepper' }));
});

test('a value holding a double quote is written single-quoted and comes back (#311)', () => {
  const quoted = one({ variable: 'title', op: 'is', value: 'say "hi"' });
  assert.equal(formatCondition(quoted), `title == 'say "hi"'`);
  assert.deepEqual(parseCondition(formatCondition(quoted)), quoted);
});

test('mixed and/or, parentheses, two variables and other operators parse to null (#311)', () => {
  const unheld = ['a and b or c', '(a or b) and c', 'a == b', 'a > "1"', '"x" == a', 'a == 3', 'a != blank', 'true', 'a.b == "x"', ''];
  for (const text of unheld) assert.equal(parseCondition(text), null, text);
});

test('chainMarkers writes the unless form only for a first branch that is a single isNo (#311)', () => {
  const dry = one({ variable: 'dryRun', op: 'isNo' });
  const tests = one({ variable: 'testCommand', op: 'hasValue' });
  assert.deepEqual(chainMarkers({ branches: [dry], else: true }), ['{% unless dryRun %}', '{% else %}', '{% endunless %}']);
  assert.deepEqual(chainMarkers({ branches: [tests, dry], else: false }), ['{% if testCommand %}', '{% elsif dryRun == false %}', '{% endif %}']);
  assert.deepEqual(
    chainMarkers({ branches: [{ connective: 'and', terms: [...dry.terms, ...tests.terms] }], else: false }),
    ['{% if dryRun == false and testCommand %}', '{% endif %}'],
  );
});
