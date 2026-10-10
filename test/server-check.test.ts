import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import express from 'express';
import { localActivityId } from '../src/activities.js';
import { createConsoleStore } from '../src/console.js';
import { parseConfig } from '../src/config.js';
import { initialState } from '../src/orchestrator.js';
import { registerCheckRoutes } from '../src/server-check.js';
import { type CheckAnswer, type CheckerState, EDITOR_DEFAULTS, type EditorConfig } from '../src/types.js';
import { combConfig, LOCAL_STAGES } from './fakes.js';
import { savedActivityId, withLocal } from './fixtures/work.js';
import { type AfterHost, tempDir } from './temp-dir.js';

const ACTIVITY = encodeURIComponent(localActivityId('hive'));

async function script(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

// A local activity of workspace hive at a temp repo holding a.py and a project mypy that reports one finding on it
async function serve(t: AfterHost, editor: EditorConfig = EDITOR_DEFAULTS): Promise<{ base: string; repo: string }> {
  const repo = await realpath(await tempDir(t, 'check-repo-'));
  await writeFile(join(repo, 'a.py'), 'x: int = "a"\n');
  await script(join(repo, '.venv', 'bin', 'mypy'), `printf '{"file": "%s", "line": 1, "column": 9, "message": "bad", "hint": null, "code": "assignment", "severity": "error"}\\n' "$4"; exit 1`);
  const config = parseConfig(combConfig({ stages: LOCAL_STAGES, path: repo, editor }));
  const state = withLocal(initialState(0), 'hive');
  const app = express();
  app.use(express.json());
  registerCheckRoutes(app, { requireLive: () => ({ state, runtime: { config, sources: new Map(), promptsDir: '', pluginDir: '' } }), consoleStore: createConsoleStore(() => 5000) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, repo };
}
const post = (base: string, activity: string, checker: string, body: unknown): Promise<Response> =>
  fetch(`${base}/activities/${activity}/check/${checker}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('POST check runs the checker on the file and answers its diagnostics and console run (#782)', async (t) => {
  const { base } = await serve(t);
  const res = await post(base, ACTIVITY, 'mypy', { path: 'a.py' });
  assert.equal(res.status, 200);
  const answer = (await res.json()) as CheckAnswer;
  assert.ok(answer.state === 'done');
  assert.deepEqual(answer.diagnostics, [{ path: 'a.py', line: 1, column: 10, severity: 'error', message: 'bad', code: 'assignment' }]);
  assert.equal(answer.log.channel, 'check:hive:mypy');
});

test('POST check refuses an unknown activity, no path, a checker that is not a command line or does not read the file, and a path outside the activity; off is absent (#782)', async (t) => {
  const { base } = await serve(t);
  const outside = join(await realpath(await tempDir(t, 'check-out-')), 'b.py');
  await writeFile(outside, 'x = 1\n');
  const cases: [string, string, unknown, number, RegExp][] = [
    [encodeURIComponent(savedActivityId(99)), 'mypy', { path: 'a.py' }, 404, /atividade desconhecida/],
    [ACTIVITY, 'mypy', {}, 400, /^path must be a non-empty string$/],
    [ACTIVITY, 'ruff', { path: 'a.py' }, 400, /^ruff is not a command-line checker$/],
    [ACTIVITY, 'tsc', { path: 'a.py' }, 400, /^tsc does not check a\.py$/],
    [ACTIVITY, 'mypy', { path: outside }, 400, /^path must be a file inside the activity$/],
    [ACTIVITY, 'mypy', { path: 'nope.py' }, 404, /file not found/],
  ];
  for (const [activity, checker, body, status, error] of cases) {
    const res = await post(base, activity, checker, body);
    assert.equal(res.status, status, `${checker} ${JSON.stringify(body)}`);
    assert.match(((await res.json()) as { error: string }).error, error);
  }
  const off = await serve(t, { ...EDITOR_DEFAULTS, languages: { python: { checkers: { mypy: { enabled: false, args: [], workspaces: 'all' } } } } });
  assert.deepEqual(await (await post(off.base, ACTIVITY, 'mypy', { path: 'a.py' })).json(), { state: 'absent' });
});

test('GET /settings/checkers answers every checker with the workspaces that have it: a language-server one by its project copy (#782)', async (t) => {
  const { base, repo } = await serve(t);
  await script(join(repo, 'node_modules', '.bin', 'eslint'), 'exit 0');
  const states = (await (await fetch(`${base}/settings/checkers`)).json()) as CheckerState[];
  assert.equal(states.length, 25);
  const found = (id: string): string[] | undefined => states.find((s) => s.id === id)?.found;
  assert.deepEqual([found('mypy'), found('eslint'), found('ruff'), found('biome')], [['hive'], ['hive'], [], []]);
});
