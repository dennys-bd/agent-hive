import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_ALIASES, CLAUDE_VERSIONS } from '../src/agents/claude-models.js';
import { parseCodexModels, specializedAgents } from '../src/launch-options.js';
import type { Exec, LaunchOptions } from '../src/types.js';
import { send, settingsBody, startReviews } from './review-server.js';

// #257: what the new session dialog lists, read each time it opens
const CODEX_MODELS = JSON.stringify({ models: [
  { slug: 'gpt-hidden', display_name: 'GPT hidden', visibility: 'hide' },
  { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list' },
] });
// git answers nothing; `codex debug models` answers `codex()`
const withCodex = (codex: () => string): Exec => async (file) => ({ stdout: file === 'codex' ? codex() : '' });

test('parseCodexModels lists visible slugs first, hidden after, display_name as the hint; an entry with no usable slug drops (#257)', () => {
  const stdout = JSON.stringify({ models: [
    { slug: 'gpt-old', display_name: 'GPT old', visibility: 'hide' },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list' },
    { slug: '-bad', visibility: 'list' },
    { display_name: 'no slug' },
    { slug: 'gpt-5.6-terra-mini', display_name: 'gpt-5.6-terra-mini', visibility: 'list' },
  ] });
  assert.deepEqual(parseCodexModels(stdout), [{ id: 'gpt-5.6-terra', hint: 'GPT-5.6 Terra' }, { id: 'gpt-5.6-terra-mini' }, { id: 'gpt-old', hint: 'GPT old' }]);
  assert.deepEqual(parseCodexModels(JSON.stringify([{ slug: 'gpt-x' }])), [{ id: 'gpt-x' }], 'a bare list reads too');
  assert.throws(() => parseCodexModels('not json'));
});

test('specializedAgents lists the Hive plugin\'s agents as hive:<name>, sorted by file, with the body Codex gets (#257)', () => {
  const agents = specializedAgents();
  assert.ok(agents.length > 0);
  assert.ok(agents.every((a) => a.name.startsWith('hive:') && a.description !== '' && a.instructions !== ''));
  assert.ok(agents.some((a) => a.name === 'hive:designer'));
});

test('GET /launch-options lists Claude\'s hand-kept models, Codex\'s in visible-then-hidden order, the plugin\'s agents for both and each agent\'s config args (#257)', async (t) => {
  const { base } = await startReviews(t, { exec: withCodex(() => CODEX_MODELS) });
  const { workspaces: _saved, ...rest } = settingsBody('');
  const agentArgs = { claude: ['--permission-mode', 'auto'], codex: ['--sandbox', 'workspace-write'] };
  assert.equal((await send(base, 'POST', '/settings', { ...rest, agentArgs })).status, 200, 'an API save that omits workspaces keeps them');
  const res = await send(base, 'GET', '/launch-options');
  assert.equal(res.status, 200);
  const options = (await res.json()) as LaunchOptions;
  assert.deepEqual([options.claude.aliases, options.claude.versions], [[...CLAUDE_ALIASES], [...CLAUDE_VERSIONS]]);
  assert.deepEqual([options.codex.aliases, options.codex.versions.map((m) => m.id)], [[], ['gpt-5.6-terra', 'gpt-hidden']]);
  const agents = specializedAgents().map(({ name, description }) => ({ name, description }));
  assert.deepEqual([options.claude.specializedAgents, options.codex.specializedAgents], [agents, agents]);
  assert.deepEqual([options.claude.args, options.codex.args], [agentArgs.claude, agentArgs.codex]);
});

test('a codex debug models that fails or prints no JSON gives Codex no models and still answers 200 (#257)', async (t) => {
  for (const codex of [() => { throw new Error('codex: command not found'); }, () => 'Usage: codex debug'] as const) {
    const { base } = await startReviews(t, { exec: withCodex(codex) });
    const res = await send(base, 'GET', '/launch-options');
    assert.equal(res.status, 200);
    const options = (await res.json()) as LaunchOptions;
    assert.deepEqual(options.codex.versions, []);
    assert.deepEqual(options.claude.versions, [...CLAUDE_VERSIONS]);
  }
});
