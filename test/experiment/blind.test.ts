import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { ARM_LEAK, assertBlind, bundleFiles, hasTell, PLUGIN_SUBAGENTS, REDACTED, scrub } from '../../scripts/experiment/blind.js';
import { deliveredName } from '../../src/template.js';
import type { Metrics } from '../../scripts/experiment/types.js';

const T0 = '2026-10-01T22:00:00.000Z';
const METRICS: Metrics = {
  token: 'abc123', outcome: 'done', startedAt: T0, endedAt: T0,
  costUsd: 1.5,
  tasks: [{ key: 'grid', title: 'Monitor View 1', tokens: 5, ms: 6, waitingMs: 0, stages: [{ stage: 'Spec', ms: 6 }], restarts: 1 }],
  tokens: 5, ms: 6, waitingMs: 0, restarts: { count: 1, where: ['spec · grid'] }, diff: { files: 1, insertions: 2, deletions: 0 }, tests: { green: 1, total: 1 }, unpaired: true,
};
const TELL_TEXT = 'Ran /hive-spec, then /hive:new-plan with superpowers:brainstorming and ecc:tdd-workflow; the code-reviewer and the planner agreed; docs/superpowers/specs/x.md; new-build, hive-pr.';

test('scrub turns every arm tell into [redacted], and the scrubbed text holds none (#105)', () => {
  const text = scrub(TELL_TEXT);
  assert.equal(hasTell(text), false, text);
  assert.ok(text.includes(`Ran ${REDACTED}, then ${REDACTED} with ${REDACTED}`), text);
  assert.ok(text.includes(`docs/${REDACTED}/specs/x.md`), text);
  assert.equal(scrub('feat/monitor-view-abc123 MABC123-1 hive_done pnpm test'), 'feat/monitor-view-abc123 MABC123-1 hive_done pnpm test');
});

test('PLUGIN_SUBAGENTS is every agent of the plugin (#105)', async () => {
  const names = (await readdir(new URL('../../../assets/plugin/agents/', import.meta.url))).map(deliveredName).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)).sort();
  assert.deepEqual([...PLUGIN_SUBAGENTS].sort(), names);
});

test('the bundle has harness-made names, scrubbed texts, numbers-only metrics, and no tell anywhere (#105)', () => {
  const files = bundleFiles({
    handoffShots: ['/x/seed/handoff/png/4a-padrao.png'],
    runShots: ['/x/screens/screen-4a.png', '/x/screens/S1-1.png', '/x/screens/arm-b-hive-spec.png'],
    clicks: [{ scenario: 'S1', passed: true, notes: TELL_TEXT, screenshots: ['S1-1.png', 'arm-b-hive-spec.png'] }],
    docs: [{ kind: 'spec', text: TELL_TEXT }, { kind: 'plan', text: 'Then /hive:new-build.' }],
    diff: `+${TELL_TEXT}\n`, metrics: METRICS,
  });
  assert.doesNotThrow(() => assertBlind(files));
  assert.deepEqual(files.map((f) => f.name), ['handoff/4a-padrao.png', 'run/screen-4a.png', 'run/S1-1.png', 'run/shot-03.png', 'clicks.json', 'docs/spec-1.md', 'docs/plan-1.md', 'diff.patch', 'metrics.json']);
  for (const f of files) assert.ok(!hasTell(f.text ?? '') && !ARM_LEAK.test(f.name), f.name);
  const metrics = JSON.parse(files.find((f) => f.name === 'metrics.json')?.text ?? '{}') as Record<string, unknown>;
  for (const key of ['token', 'reason', 'tests', 'costUsd', 'unpaired']) assert.equal(metrics[key], undefined, key);
  assert.equal(metrics.restarts, 1);
});

test('assertBlind refuses a tell in a name or in a text (#105)', () => {
  for (const name of ['run/x-b-y.png', 'docs/new-spec.md', 'arm.json']) assert.throws(() => assertBlind([{ name, text: '' }]), /would name the arm/, name);
  assert.throws(() => assertBlind([{ name: 'diff.patch', text: 'uses superpowers' }]), /would name the arm/);
});
