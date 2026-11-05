// Run through scripts/test-node.mjs by test/test-node.test.ts (#624): it reports the homes the runner gave it, then passes, fails or waits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, writeFileSync } from 'node:fs';

// Longer than the test takes to interrupt it: a runner that forwards nothing lets the probe pass, and the test's exit-code check fails.
const WAIT_MS = 30_000;

test('env probe', async () => {
  const out = process.env.PROBE_OUT;
  if (out === undefined) throw new Error('PROBE_OUT is not set');
  // tmp + rename: the test polls for this file and must never read half of it
  writeFileSync(`${out}.tmp`, JSON.stringify({ codexHome: process.env.CODEX_HOME, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR }));
  renameSync(`${out}.tmp`, out);
  if (process.env.PROBE_MODE === 'fail') assert.fail('the probe fails on purpose');
  if (process.env.PROBE_MODE === 'wait') await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
});
