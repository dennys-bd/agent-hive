import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecomposition } from '../src/decomposition.js';

// Leaves touching the same files with nothing ordering them (#936): a warning, never a problem, one per shared path (#555), at its first
// leaf's Touches: line.

const file = (...lines: string[]): string => lines.join('\n');
// A leaf is 7 lines, its Touches: the 6th; an inner node 4 lines
const leaf = (id: string, touches: string, blockedBy = ''): string[] =>
  [`## ${id} N${id}`, '### Scope', 'In: a.', '### Acceptance criteria', '- it works', `Touches: ${touches}`, `Blocked by: ${blockedBy}`];
const inner = (id: string, blockedBy = ''): string[] => [`## ${id} N${id}`, '### Scope', 'In: a.', `Blocked by: ${blockedBy}`];
function warningsOf(...lines: string[]) {
  const parsed = parseDecomposition(file('# G', ...lines));
  assert.deepEqual(parsed.problems, []);
  return parsed.warnings;
}

const touched = (path: string, ...ids: string[]): string =>
  `"${path}" is touched by ${ids.map((id) => `"${id}"`).join(', ')}, and no "Blocked by:" orders some of them`;

test('two leaves touching the same path, or a folder and a file in it, warn at the first one\'s Touches: line; a sibling name does not (#936)', () => {
  assert.deepEqual(warningsOf(...leaf('1', 'src/a.ts'), ...leaf('2', 'src/a.ts')), [{ line: 7, message: touched('src/a.ts', '1', '2') }]);
  assert.deepEqual(warningsOf(...leaf('1', 'src/a.ts'), ...leaf('2', 'src/')), [{ line: 7, message: touched('src', '1', '2') }]);
  assert.deepEqual(warningsOf(...leaf('1', 'src/a'), ...leaf('2', 'src/ab')), []);
});

test('a direct or a chained Blocked by orders two leaves: no warning (#936)', () => {
  assert.deepEqual(warningsOf(...leaf('1', 'src'), ...leaf('2', 'src/a.ts', '1')), []);
  assert.deepEqual(warningsOf(...leaf('1', 'src'), ...leaf('2', 'docs', '1'), ...leaf('3', 'src/a.ts', '2')), []);
});

test('an ancestor\'s Blocked by orders its leaves after the blocker and everything under it; without it, the warning (#936)', () => {
  const tree = (blocked: string): string[] => [
    ...inner('1'), ...leaf('1.1', 'src'), ...leaf('1.2', 'lib'), ...inner('2', blocked), ...leaf('2.1', 'src/a.ts'), ...leaf('2.2', 'x'),
  ];
  assert.deepEqual(warningsOf(...tree('1')), []);
  assert.deepEqual(warningsOf(...tree('')), [{ line: 11, message: touched('src', '1.1', '2.1') }]);
});

test('many leaves on one path give one line naming every leaf in an unordered pair, one line per path, by line (#555)', () => {
  assert.deepEqual(warningsOf(...leaf('1', 'docs'), ...leaf('2', 'src/a.ts'), ...leaf('3', 'src/a.ts', '2'), ...leaf('4', 'src/a.ts'), ...leaf('5', 'docs/x.md')), [
    { line: 7, message: touched('docs', '1', '5') },
    { line: 14, message: touched('src/a.ts', '2', '3', '4') },
  ]);
});

test('a file with a problem has no warnings: the problems come first (#936)', () => {
  const parsed = parseDecomposition(file('# G', ...leaf('1', 'src'), ...leaf('2', 'src'), '## 3 X', '### Acceptance criteria', '- ok'));
  assert.deepEqual([parsed.problems.length > 0, parsed.warnings], [true, []]);
});
