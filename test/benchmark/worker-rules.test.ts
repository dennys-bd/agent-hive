import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaudeArgs, runRules } from '../../src/benchmark/worker-rules.js';

const PATHS = { home: '/hive/benchmark/e/runs/abcd1234', homes: ['/hive', '/hive/benchmark/*/runs/*'], denied: ['/hive/benchmark/*/seed', '/hive/benchmark/*/report.md'] };

test('a run allows its own push and its own plugins, and denies every home\'s daemon files and the experiment\'s seed and report (#471)', () => {
  const { allow, deny } = runRules('work/abcd1234', PATHS);
  assert.deepEqual(allow, ['Bash(git push origin HEAD:work/abcd1234*)', 'Bash(git push origin *:work/abcd1234*)', 'Read(//hive/benchmark/e/runs/abcd1234/plugins/**)']);
  for (const rule of ['Read(//hive/hive.*)', 'Read(//hive/benchmark/*/runs/*/*.json)', 'Read(//hive/benchmark/*/runs/*/custom/**)', 'Read(//hive/benchmark/*/seed/**)', 'Read(//hive/benchmark/*/report.md)']) assert.ok(deny.includes(rule), rule);
});

test('a `*` stands only as a whole segment, and a path a rule cannot hold is refused (#471)', () => {
  for (const home of ['relative/h', '/with space/h', '/glob*x/h', '/p(a)/h']) assert.throws(() => runRules('work/a', { ...PATHS, home }), /permission rule/, home);
  assert.deepEqual(runClaudeArgs([], 'work/a', PATHS).slice(0, 1), ['--allowedTools']);
});
