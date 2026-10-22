import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaudeArgs, runRules, splitRules } from '../../src/benchmark/worker-rules.js';

const PATHS = { home: '/hive/benchmark/e/runs/abcd1234', homes: ['/hive', '/hive/benchmark/*/runs/*'], denied: ['/hive/benchmark/*/seed', '/hive/benchmark/*/report.md'] };

test('a run allows its own push and its own plugins, and denies every home\'s daemon files and the experiment\'s seed and report (#471)', () => {
  const { allow, deny } = runRules('work/abcd1234', PATHS);
  assert.deepEqual(allow, ['Bash(git push origin HEAD:work/abcd1234)', 'Bash(git push origin HEAD:work/abcd1234 2>&1)', 'Bash(git push origin *:work/abcd1234)', 'Bash(git push origin *:work/abcd1234 2>&1)', 'Read(//hive/benchmark/e/runs/abcd1234/plugins/**)']);
  for (const rule of ['Read(//hive/hive.*)', 'Read(//hive/benchmark/*/runs/*/*.json)', 'Read(//hive/benchmark/*/runs/*/custom/**)', 'Read(//hive/benchmark/*/seed/**)', 'Read(//hive/benchmark/*/report.md)']) assert.ok(deny.includes(rule), rule);
});

test('a `*` stands only as a whole segment, and a path a rule cannot hold is refused (#471)', () => {
  for (const home of ['relative/h', '/with space/h', '/glob*x/h', '/p(a)/h']) assert.throws(() => runRules('work/a', { ...PATHS, home }), /permission rule/, home);
  assert.deepEqual(runClaudeArgs([], 'work/a', PATHS).slice(0, 1), ['--allowedTools']);
});

test('no push rule ends in a wildcard: a second refspec cannot follow the run\'s own, only the 2>&1 redirect the workers write (#471)', () => {
  for (const rule of runRules('work/abcd1234', PATHS).allow.filter((r) => r.startsWith('Bash(git push'))) assert.match(rule, /work\/abcd1234( 2>&1)?\)$/, rule);
});

test('splitRules splits on spaces and commas outside parentheses (#459)', () => {
  assert.deepEqual(splitRules('Read, Bash(git log:*)  Bash(npm run test:coverage *)'), ['Read', 'Bash(git log:*)', 'Bash(npm run test:coverage *)']);
});
