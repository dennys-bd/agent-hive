import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { initialState } from '../src/orchestrator.js';
import { PR_ROUTE, type PrRouteDeps, prTarget } from '../src/server-pr.js';
import type { CombConfig, Exec, Workspace } from '../src/types.js';
import { fakeMachine } from './fake-machine.js';

const workspace = (name: string): Workspace => ({ name, path: `/code/${name}`, env: {}, fork: null, nestedRepos: [], notNestedRepos: [], memoryCap: 4000, variables: {}, benchmarkPrIn: 'worktree', machine: 'local', color: 'oklch(0.72 0.12 25)' });
const COMB: CombConfig = { prefix: 'HIVE', workspaces: ['app', 'lab', 'self'].map(workspace), sources: [], flows: [], commands: [], hiveSource: true, createIn: 'app' };
// acme/app on GitHub, a nested-group project on gitlab.com, one on a listed self-hosted GitLab
const ORIGINS: Record<string, string> = { '/code/app': 'git@github.com:acme/app.git\n', '/code/lab': 'https://gitlab.com/acme/platform/app.git\n', '/code/self': 'git@git.example.com:group/sub/proj.git\n' };
const exec: Exec = async (_file, args) => ({ stdout: ORIGINS[String(args[1])] ?? '' });
const UNLISTED = { error: 'repository is not one the Hive lists' };

// prTarget alone behind PR_ROUTE: what every PR route names its PR with, so its answer is every route's
async function serve(t: TestContext): Promise<string> {
  const deps = {
    requireLive: () => ({ state: initialState(0), runtime: { config: { comb: COMB, gitlabHosts: ['git.example.com'] } } }),
    machineFor: () => fakeMachine({ exec }),
  } as unknown as Pick<PrRouteDeps, 'requireLive' | 'machineFor'>;
  const app = express();
  app.get(PR_ROUTE, async (req, res) => {
    const found = await prTarget(deps, req, res);
    if (found) res.json({ url: found.url });
  });
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function get(url: string): Promise<[number, unknown]> {
  const res = await fetch(url);
  return [res.status, await res.json()];
}

test('a PR route names its repository by host and one encoded path segment: a GitHub PR answers its link, a GitLab one the 409, a wrong or unlisted host the 404 (#1045, decisions 6 to 8)', async (t) => {
  const base = await serve(t);
  assert.deepEqual(await get(`${base}/repositories/github.com/acme%2Fapp/pulls/7`), [200, { url: 'https://github.com/acme/app/pull/7' }]);
  const notRead = [409, { error: 'GitLab repositories are not read yet' }];
  assert.deepEqual(await get(`${base}/repositories/gitlab.com/acme%2Fplatform%2Fapp/pulls/3`), notRead);
  assert.deepEqual(await get(`${base}/repositories/git.example.com/group%2Fsub%2Fproj/pulls/3`), notRead, 'a nested path decodes from one segment');
  assert.deepEqual(await get(`${base}/repositories/gitlab.com/acme%2Fapp/pulls/7`), [404, UNLISTED], 'acme/app is listed on github.com only');
  assert.deepEqual(await get(`${base}/repositories/code.example.org/acme%2Fapp/pulls/7`), [404, UNLISTED], 'a host the Hive does not list');
  assert.deepEqual(await get(`${base}/repositories/github.com/acme%2Fother/pulls/7`), [404, UNLISTED]);
  assert.deepEqual(await get(`${base}/repositories/acme/app/pulls/7`), [404, UNLISTED], 'the :owner/:name shape is gone: acme is no host the Hive lists');
});
