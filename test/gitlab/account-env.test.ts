import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '../../src/account-error.js';
import { refusalLine } from '../../src/account-env.js';
import { gitlabEnv, type GitlabEnvDeps } from '../../src/gitlab/account-env.js';
import type { Credentials } from '../../src/types.js';
import { APP_WORKSPACE } from '../fixtures/accounts.js';

const TOKEN = `glpat-test-${randomUUID()}`; // built at runtime: no token in a fixture
const EXPIRED_TOKEN = `glpat-test-${randomUUID()}`;
const STORE: Credentials = {
  gitlab: { 'gitlab.com': { token: TOKEN, username: 'ana' }, 'git.example.com': { token: EXPIRED_TOKEN, username: 'ana', expiresAt: '2020-01-31' } },
};

// gitlabOrigin answers `origin` and records the workspace it was asked about
function deps(origin: string | undefined, credentials = async (): Promise<Credentials> => STORE): GitlabEnvDeps & { asked: string[] } {
  const asked: string[] = [];
  return { asked, credentials, gitlabOrigin: async (workspace) => { asked.push(workspace.name); return origin; } };
}

test('a workspace whose origin is on a GitLab host with an account gets GITLAB_TOKEN and GITLAB_HOST for that host; an expired account\'s token is passed as is (#1049)', async () => {
  const on = deps('gitlab.com');
  assert.deepEqual(await gitlabEnv(APP_WORKSPACE, on), { GITLAB_TOKEN: TOKEN, GITLAB_HOST: 'gitlab.com' });
  assert.deepEqual(on.asked, ['app']);
  assert.deepEqual(await gitlabEnv(APP_WORKSPACE, deps('git.example.com')), { GITLAB_TOKEN: EXPIRED_TOKEN, GITLAB_HOST: 'git.example.com' }, 'glab gets the 401; Settings shows expired');
});

test('no account for the host, an origin off GitLab and no workspace give neither variable; with no GitLab account stored the origin is never read (#1049)', async () => {
  assert.deepEqual(await gitlabEnv(APP_WORKSPACE, deps('code.example.org')), {}, 'a GitLab host with no account');
  assert.deepEqual(await gitlabEnv(APP_WORKSPACE, deps('toString')), {}, 'own entries only');
  const empty = deps('gitlab.com', async () => ({}));
  assert.deepEqual(await gitlabEnv(APP_WORKSPACE, empty), {}, 'an empty store');
  assert.deepEqual(empty.asked, [], 'no GitLab account stored: no git call on the origin');
  const broken = async (): Promise<Credentials> => { throw new Error('never read'); };
  assert.deepEqual(await gitlabEnv(APP_WORKSPACE, deps(undefined, broken)), {}, 'GitHub, no origin, a remote of no kind or a failing git: a rejecting store refuses only a GitLab origin');
  const none = deps('gitlab.com', broken);
  assert.deepEqual(await gitlabEnv(undefined, none), {});
  assert.deepEqual(none.asked, [], 'no workspace: no origin read');
});

test('a credential read that rejects refuses with gitlab / unreachable, whose message and refusal line hold no token (#1049)', async () => {
  const leaking = async (): Promise<Credentials> => { throw new Error(`store broke near ${TOKEN}`); };
  const err = await gitlabEnv(APP_WORKSPACE, deps('gitlab.com', leaking)).then(() => undefined, (e: unknown) => e);
  assert.ok(err instanceof AccountError, String(err));
  assert.deepEqual([err.provider, err.code, err.message, refusalLine(err)], ['gitlab', 'unreachable', 'account gitlab unreachable', 'account gitlab unreachable']);
  assert.ok(!err.message.includes(TOKEN) && err.reason === undefined);
});
