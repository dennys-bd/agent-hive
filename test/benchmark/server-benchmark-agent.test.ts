import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localActivityId } from '../../src/activities.js';
import { ASK_RULE, askPrompt } from '../../src/server-benchmark-agent.js';
import { call, errorOf, serve } from './bench-server.js';
import { benchExperiment } from './fixtures.js';

const A = '/benchmark/agent';

test('askPrompt names the description, the workspace, the from experiment with benchmark_get first, the three tools and the rule (#478)', () => {
  const prompt = askPrompt({ description: 'compare tdd', workspace: 'bench', from: 'exp-1' });
  for (const part of ['compare tdd', 'bench', 'mcp__hive__benchmark_get with id "exp-1" first', 'mcp__hive__benchmark_list', 'mcp__hive__benchmark_draft', ASK_RULE]) assert.ok(prompt.includes(part), part);
  assert.ok(askPrompt({ description: 'x', workspace: 'bench' }).includes('pass workspace "bench" to benchmark_draft'));
});

test('POST /benchmark/agent opens a local session in the workspace with the rendered prompt, the agent and the model (#478)', async (t) => {
  const bench = await serve(t, { experiments: [benchExperiment()] });
  assert.deepEqual(await call(bench, 'POST', A, { description: '  compare tdd  ', workspace: 'bench', from: 'exp-1', kind: 'claude', model: 'opus' }), [200, { ok: true }]);
  assert.deepEqual(bench.sessionEvents, [{
    type: 'newLocalSession', activityId: localActivityId('bench'), agent: 'claude', launch: { model: 'opus' },
    prompt: askPrompt({ description: 'compare tdd', workspace: 'bench', from: 'exp-1' }),
  }]);
  await call(bench, 'POST', A, { description: 'x', workspace: 'bench' });
  assert.equal('agent' in bench.sessionEvents[1], false, 'no kind: the live default agent');
});

test('POST /benchmark/agent refuses a bad description, an unknown agent or a refused launch, an unknown workspace or from, a from of another workspace and mcp.off holding benchmark_draft or benchmark_get; nothing is dispatched (#478)', async (t) => {
  const other = benchExperiment({ id: 'exp-9', workspace: 'other', seed: { ...benchExperiment().seed, workspace: 'other' } });
  const bench = await serve(t, { experiments: [benchExperiment(), other] });
  const ok = { description: 'x', workspace: 'bench' };
  const answers = [
    await call(bench, 'POST', A, { ...ok, description: '   ' }), await call(bench, 'POST', A, { ...ok, description: 'x'.repeat(4001) }),
    await call(bench, 'POST', A, { ...ok, kind: 'gpt' }), await call(bench, 'POST', A, { ...ok, kind: 'codex', model: 'opus' }),
    await call(bench, 'POST', A, { ...ok, workspace: 'ghost' }), await call(bench, 'POST', A, { ...ok, from: 'nope' }),
    await call(bench, 'POST', A, { ...ok, from: 'exp-9' }),
  ];
  assert.deepEqual(answers.map(errorOf), [[400, 'bad_body'], [400, 'bad_body'], [400, 'unknown_agent'], [400, 'bad_launch'], [404, 'unknown_workspace'], [404, 'unknown_experiment'], [400, 'other_workspace']]);
  assert.deepEqual(bench.sessionEvents, []);
  assert.ok(bench.lines.every((line) => !line.includes('xxxx')), 'the description never reaches hive.log');
  for (const off of [['benchmark_draft'], ['benchmark_get']] as const) {
    const gated = await serve(t, { mcpOff: [...off] });
    assert.deepEqual(errorOf(await call(gated, 'POST', A, ok)), [409, 'mcp_off']);
    assert.deepEqual(gated.sessionEvents, []);
  }
});