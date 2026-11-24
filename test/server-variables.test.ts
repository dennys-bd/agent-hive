import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { parseConfig } from '../src/config.js';
import type { RenderConfig } from '../src/plugin-render.js';
import { NAME_MESSAGE, registerVariableRoutes, SAVE_MESSAGE, WORKSPACE_MESSAGE } from '../src/server-variables.js';
import type { Config } from '../src/types.js';
import { combConfig, fakeLog, GITHUB_ENTRY } from './fakes.js';

// PUT / DELETE /workspaces/:workspace/variables/:name (#621, decision 11): one value at a time, on the settings chain, one workspace re-rendered
interface Rig { base: string; saved: Config[]; renders: [RenderConfig, readonly string[] | undefined][]; protocols: [string, readonly string[]][]; lines: string[]; current(): Config }

async function serve(t: TestContext, failSave = false): Promise<Rig> {
  const parsed = parseConfig(combConfig({ sources: [GITHUB_ENTRY] }));
  const [hive] = parsed.comb.workspaces;
  let config: Config = { ...parsed, comb: { ...parsed.comb, workspaces: [{ ...hive, variables: { keep: 'x' } }, { ...hive, name: 'site', path: '/site', variables: {} }] } };
  const saved: Config[] = [];
  const renders: [RenderConfig, readonly string[] | undefined][] = [];
  const protocols: [string, readonly string[]][] = [];
  const { log, lines } = fakeLog();
  const app = express();
  app.use(express.json());
  registerVariableRoutes(app, {
    requireLive: () => ({ runtime: { config } }),
    queueSave: (save) => save(),
    saveConfig: async (next) => {
      if (failSave) throw new Error('disk full');
      saved.push(next);
      config = next;
    },
    plugin: { write: async (next, only) => void renders.push([next, only]) },
    memory: { writeProtocol: async (name, off) => void protocols.push([name, off]) },
    log,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, saved, renders, protocols, lines, current: () => config };
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<[number, unknown]> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return [res.status, await res.json()];
}

test('PUT sets one of a workspace\'s variables and DELETE removes it: each saves the config and re-renders that workspace alone (#621, decision 11)', async (t) => {
  const r = await serve(t);
  assert.deepEqual(await call(r.base, 'PUT', '/workspaces/hive/variables/specsDir', { value: 'design/specs' }), [200, { variables: { keep: 'x', specsDir: 'design/specs' } }]);
  assert.deepEqual(await call(r.base, 'PUT', '/workspaces/hive/variables/quick', { value: false }), [200, { variables: { keep: 'x', specsDir: 'design/specs', quick: false } }]);
  assert.deepEqual(await call(r.base, 'PUT', '/workspaces/hive/variables/chatLanguage', { value: null }), [200, { variables: { keep: 'x', specsDir: 'design/specs', quick: false, chatLanguage: null } }]);
  assert.deepEqual(await call(r.base, 'DELETE', '/workspaces/hive/variables/keep'), [200, { variables: { specsDir: 'design/specs', quick: false, chatLanguage: null } }]);
  assert.deepEqual(await call(r.base, 'DELETE', '/workspaces/hive/variables/never'), [200, { variables: { specsDir: 'design/specs', quick: false, chatLanguage: null } }], 'a name not set removes nothing');
  assert.equal(r.saved.length, 5);
  assert.deepEqual(r.renders.map(([, only]) => only), [['hive'], ['hive'], ['hive'], ['hive'], ['hive']]);
  assert.equal(r.renders[4]?.[0], r.saved[4], 'the render reads the config just saved');
  assert.deepEqual(r.protocols.map(([name]) => name), ['hive', 'hive', 'hive', 'hive', 'hive'], 'its protocol files render its passages with the new values');
  assert.equal(r.protocols[4]?.[1], r.saved[4]?.mcp.off, 'with the tools the config turns off');
  assert.deepEqual(r.current().comb.workspaces.map((w) => w.variables), [{ specsDir: 'design/specs', quick: false, chatLanguage: null }, {}]);
});

test('a 400 names the field: an unknown workspace, a name a template cannot declare, a value that is not a string, a boolean or null; nothing is saved (#621, decision 11)', async (t) => {
  const r = await serve(t);
  assert.deepEqual(await call(r.base, 'PUT', '/workspaces/nobody/variables/specsDir', { value: 'x' }), [400, { error: WORKSPACE_MESSAGE }]);
  assert.deepEqual(await call(r.base, 'DELETE', '/workspaces/nobody/variables/specsDir'), [400, { error: WORKSPACE_MESSAGE }]);
  for (const name of ['workspace', 'nestedRepos', '2fast', 'a-b']) assert.deepEqual(await call(r.base, 'PUT', `/workspaces/hive/variables/${name}`, { value: 'x' }), [400, { error: NAME_MESSAGE }], name);
  for (const body of [{ value: 3 }, { value: ['x'] }, { value: { a: 1 } }, {}]) {
    const [status, answer] = await call(r.base, 'PUT', '/workspaces/hive/variables/specsDir', body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.match((answer as { error: string }).error, /^value: /);
  }
  assert.deepEqual([r.saved, r.renders, r.protocols], [[], [], []]);
});

test('a config the disk refuses is a 500 with no render, its cause logged by class only (#621)', async (t) => {
  const r = await serve(t, true);
  assert.deepEqual(await call(r.base, 'PUT', '/workspaces/hive/variables/specsDir', { value: 'x' }), [500, { error: SAVE_MESSAGE }]);
  assert.deepEqual([r.renders, r.protocols], [[], []]);
  assert.deepEqual(r.lines, ['ERROR variables hive: hive.config.json not written (Error)']);
});

test('a name like __proto__ is an own entry of the workspace\'s values, never its prototype (#621)', async (t) => {
  const r = await serve(t);
  const [status] = await call(r.base, 'PUT', '/workspaces/site/variables/__proto__', { value: 'x' });
  assert.equal(status, 200);
  const variables = r.current().comb.workspaces[1]?.variables ?? {};
  assert.equal(Object.getPrototypeOf(variables), Object.prototype);
  assert.deepEqual(Object.entries(variables), [['__proto__', 'x']]);
});
