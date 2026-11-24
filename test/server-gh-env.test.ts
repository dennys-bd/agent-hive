import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeCredentials } from '../src/credentials.js';
import { initialState } from '../src/orchestrator.js';
import { createServer } from '../src/server.js';
import { saveState } from '../src/state-store.js';
import type { Exec, Stage, Task } from '../src/types.js';
import { WORKSPACE, tempHive, withToplevel } from './fakes.js';
import { savedActivityId, withWork } from './fixtures/work.js';
import { send, settingsBody } from './review-server.js';
import { SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

// #961 end to end: the daemon's own gh calls, here the poll's PR states through server.ts's injected exec, run as accounts.github's login
const GH_TEST = 'gho_test'; // a placeholder, never a real token
const PR = 'https://github.com/acme/app/pull/7';
const STAGES: Stage[] = [{ name: 'fila', from: {}, prompt: 'Task {id}', approval: true }, { name: 'feito', from: {} }]; // local stages: fakes' STAGES read a board

// A Hive with one local task holding an open PR (as test/pr-server.ts builds it) and the GitHub login octo stored; answers the env of
// every gh call the server's poll made, as the exec received it
async function pollEnvs(t: TestContext, accounts: Record<string, string>): Promise<(NodeJS.ProcessEnv | undefined)[]> {
  const { home, repo } = await tempHive(t);
  const task: Task = { item: { itemId: 'local:1', id: 'HIVE-1', title: 'Task 1', body: '', url: '' }, stage: 'fila', boardColumn: '', auto: true, created: true, workspace: WORKSPACE };
  await saveState(home, withWork({ ...initialState(0), localCount: 1, tasks: [task] }, 'local:1', { id: savedActivityId(1) }, { prs: [{ url: PR, state: 'open' }] }));
  const credentialsEnv = { XDG_CONFIG_HOME: await tempDir(t, 'gh-env-cred-') };
  await writeCredentials({ github: { octo: { token: GH_TEST } } }, credentialsEnv);
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];
  const exec: Exec = async (file, _args, opts) => {
    if (file === 'gh') envs.push(opts?.env);
    return { stdout: JSON.stringify({ data: {} }) };
  };
  const server = createServer({ secret: SECRET, home, exec: withToplevel(exec), credentialsEnv, githubLogin: { env: credentialsEnv } });
  const port = await server.listen(0);
  t.after(() => server.close());
  const saved = await send(`http://127.0.0.1:${port}`, 'POST', '/settings', { ...settingsBody(repo, STAGES), accounts });
  assert.equal(saved.status, 200, await saved.text());
  await server.poll(); // awaits the PR states read
  assert.ok(envs.length > 0, 'the poll read the PR states through gh');
  return envs;
}

test('with accounts.github naming a stored login, the poll\'s gh calls through server.ts run with its GH_TOKEN (#961)', async (t) => {
  const envs = await pollEnvs(t, { github: 'octo' });
  assert.deepEqual(envs.map((env) => env?.GH_TOKEN), envs.map(() => GH_TEST));
});

test('with accounts.github absent, the same gh calls reach the exec with no env: the machine\'s login, as today (#961)', async (t) => {
  const envs = await pollEnvs(t, {});
  assert.deepEqual(envs, envs.map(() => undefined));
});
