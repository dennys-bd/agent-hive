import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { credentialsPath, jiraCredential, readCredentials, removeJiraCredential, renewJiraName, saveJiraCredential, writeCredentials } from '../src/credentials.js';
import { tempDir, type AfterHost } from './temp-dir.js';
import { assertMode } from './posix-only.js';

const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;

/** An isolated config home: XDG_CONFIG_HOME is the documented override, so the tests need no variable of their own. */
async function configHome(t: AfterHost): Promise<NodeJS.ProcessEnv> {
  return { XDG_CONFIG_HOME: await tempDir(t, 'cred-') };
}

test('credentialsPath is <XDG_CONFIG_HOME>/agent-hive/credentials.json, and ~/.config when the variable is unset, empty or relative', () => {
  assert.equal(credentialsPath({ XDG_CONFIG_HOME: '/x/cfg' }), join('/x/cfg', 'agent-hive', 'credentials.json'));
  assert.match(credentialsPath({ HOME: '/home/u' }), /[/\\]\.config[/\\]agent-hive[/\\]credentials\.json$/);
  assert.match(credentialsPath({ XDG_CONFIG_HOME: '', HOME: '/home/u' }), /[/\\]\.config[/\\]agent-hive[/\\]credentials\.json$/, 'an empty value is unset, not the cwd');
  assert.match(
    credentialsPath({ XDG_CONFIG_HOME: 'relative/cfg', HOME: '/home/u' }),
    /[/\\]\.config[/\\]agent-hive[/\\]credentials\.json$/,
    'a relative value is ignored, not resolved against cwd',
  );
});

test('a missing file, an unreadable one and a corrupt one all read as not logged in, never as a boot failure', async (t) => {
  const env = await configHome(t);
  assert.deepEqual(await readCredentials(env), {});
  const path = credentialsPath(env);
  await writeCredentials({}, env); // creates the directory
  await writeFile(path, '{not json');
  assert.deepEqual(await readCredentials(env), {});
  await writeFile(path, '"a string"');
  assert.deepEqual(await readCredentials(env), {}, 'valid JSON that is not an object is still not a credential');
  assert.deepEqual(await readCredentials({ XDG_CONFIG_HOME: join(path, 'not-a-dir') }), {});
});

test('a stored github credential with a non-string token or login reads as not logged in', async (t) => {
  const env = await configHome(t);
  const path = credentialsPath(env);
  await writeCredentials({}, env); // creates the directory
  await writeFile(path, JSON.stringify({ github: { token: { evil: true }, login: 'ana' } }));
  assert.deepEqual(await readCredentials(env), {}, 'a non-string token must never reach the Authorization header');
  await writeFile(path, JSON.stringify({ github: { token: 'gho_x', login: 42 } }));
  assert.deepEqual(await readCredentials(env), {}, 'a non-string login must never be echoed to a caller');
});

test('a malformed github field is dropped in place: a sibling provider key survives it', async (t) => {
  const env = await configHome(t);
  const path = credentialsPath(env);
  await writeCredentials({}, env); // creates the directory
  // asana isn't a real key on Credentials yet (types.ts says it's coming); the point is that readCredentials must
  // not rebuild the record from just the fields it knows, or the first sibling ever added is erased on the next
  // GitHub login (writeCredentials({ ...await readCredentials(), github }, …) is that write's own pattern).
  await writeFile(path, JSON.stringify({ asana: { token: 'sibling-token' }, github: { token: {}, login: 'ana' } }));
  assert.deepEqual(await readCredentials(env), { asana: { token: 'sibling-token' } });
});

test('writeCredentials round-trips one key per provider and replaces the whole file', async (t) => {
  const env = await configHome(t);
  await writeCredentials({ github: { token: 'gho_first', login: 'ana' } }, env);
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_first', login: 'ana' } });
  await writeCredentials({ ...(await readCredentials(env)), github: { token: 'gho_second', login: 'bia' } }, env);
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_second', login: 'bia' } });
  assert.equal((await readFile(credentialsPath(env), 'utf8')).endsWith('\n'), true);
});

test('the directory is 0700 and the file 0600', async (t) => {
  const env = await configHome(t);
  await writeCredentials({ github: { token: 'gho_x', login: 'ana' } }, env);
  const path = credentialsPath(env);
  await assertMode(t, path, OWNER_ONLY_FILE); // win32: no POSIX mode bits
  await assertMode(t, dirname(path), OWNER_ONLY_DIR); // win32: no POSIX mode bits
});

test('a pre-planted file at the old fixed temp-file name is never written through: the real temp name is unique', async (t) => {
  const env = await configHome(t);
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, 'planted', { mode: 0o666 }); // the fixed name a previous implementation reused
  await writeCredentials({ github: { token: 'gho_x', login: 'ana' } }, env);
  await assertMode(t, path, OWNER_ONLY_FILE, 'credentials.json got its own 0600, not the planted file\'s mode'); // win32: no POSIX mode bits
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_x', login: 'ana' } });
});

test('a stored mcp map keeps each well-formed value and drops a malformed entry in place; a map that is no object is dropped whole (#333)', async (t) => {
  const env = await configHome(t);
  const path = credentialsPath(env);
  await writeCredentials({}, env); // creates the directory
  await writeFile(path, JSON.stringify({ github: { token: 'gho_x', login: 'ana' }, mcp: { docs: { value: 'Bearer t0k' }, bad: { value: 7 }, worse: 'x' } }));
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_x', login: 'ana' }, mcp: { docs: { value: 'Bearer t0k' } } }, 'a non-string value must never reach a header');
  await writeFile(path, JSON.stringify({ asana: { token: 'sibling' }, mcp: ['x'] }));
  assert.deepEqual(await readCredentials(env), { asana: { token: 'sibling' } });
});

const ANA = { email: 'ana@example.com', token: 'fake-jira-token-1', accountId: 'acc-1' };
const BOB = { email: 'bob@example.com', token: 'fake-jira-token-2', accountId: 'acc-2' };

test('a jira credential round-trips by site, keeps every sibling key and is owner-only (#816)', async (t) => {
  const env = await configHome(t);
  await writeCredentials({ github: { token: 'gho_x', login: 'ana' }, mcp: { srv: { value: 'v' } } }, env);
  assert.equal(await jiraCredential('a.atlassian.net', env), undefined);
  await saveJiraCredential('a.atlassian.net', ANA, env);
  await saveJiraCredential('b.atlassian.net', BOB, env);
  assert.deepEqual(await jiraCredential('a.atlassian.net', env), ANA);
  assert.deepEqual(await jiraCredential('b.atlassian.net', env), BOB);
  await assertMode(t, credentialsPath(env), OWNER_ONLY_FILE);
  await removeJiraCredential('a.atlassian.net', env);
  assert.equal(await jiraCredential('a.atlassian.net', env), undefined);
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_x', login: 'ana' }, mcp: { srv: { value: 'v' } }, jira: { 'b.atlassian.net': BOB } });
});

test('removing a site with no login writes nothing, so an unreadable file is never rewritten without its other logins (#817)', async (t) => {
  const env = await configHome(t);
  await writeCredentials({}, env);
  await writeFile(credentialsPath(env), 'not json');
  await removeJiraCredential('a.atlassian.net', env);
  assert.equal(await readFile(credentialsPath(env), 'utf8'), 'not json');
});

test('a stored jira map keeps each well-formed site and drops a malformed entry in place; a map that is no object is dropped whole (#816)', async (t) => {
  const env = await configHome(t);
  await writeCredentials({}, env);
  const path = credentialsPath(env);
  await writeFile(path, JSON.stringify({ github: { token: 'gho_x', login: 'ana' }, jira: { 'ok.atlassian.net': ANA, 'bad1': { ...ANA, token: 7 }, 'bad2': 'x', 'bad3': { email: 'a' } } }));
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_x', login: 'ana' }, jira: { 'ok.atlassian.net': ANA } });
  await writeFile(path, JSON.stringify({ jira: ['x'] }));
  assert.deepEqual(await readCredentials(env), {});
  await writeFile(path, JSON.stringify({ jira: 'x' }));
  assert.deepEqual(await readCredentials(env), {});
});

test('a stored jira displayName round-trips, a non-string one is dropped with the login kept (#820)', async (t) => {
  const env = await configHome(t);
  await saveJiraCredential('acme.example', { ...ANA, displayName: 'Ana Lima' }, env);
  assert.deepEqual(await jiraCredential('acme.example', env), { ...ANA, displayName: 'Ana Lima' });
  await writeFile(credentialsPath(env), JSON.stringify({ jira: { 'acme.example': { ...ANA, displayName: 7 } } }));
  assert.deepEqual(await jiraCredential('acme.example', env), ANA);
});

test('renewJiraName rewrites a different name only, and gives a site with no login none (#820)', async (t) => {
  const env = await configHome(t);
  await saveJiraCredential('acme.example', { ...ANA, displayName: 'Ana Lima' }, env);
  const before = await readFile(credentialsPath(env), 'utf8');
  await renewJiraName('acme.example', 'Ana Lima', env);
  assert.equal(await readFile(credentialsPath(env), 'utf8'), before, 'the same name writes nothing');
  await renewJiraName('acme.example', 'Ana L.', env);
  assert.deepEqual(await jiraCredential('acme.example', env), { ...ANA, displayName: 'Ana L.' });
  await renewJiraName('other.example', 'Bea', env);
  assert.equal(await jiraCredential('other.example', env), undefined);
});

test('concurrent credential updates are serialized: a name renewal never writes an older token back (#820)', async (t) => {
  const env = await configHome(t);
  await saveJiraCredential('acme.example', { ...ANA, displayName: 'Ana Lima' }, env);
  await Promise.all([renewJiraName('acme.example', 'Ana L.', env), saveJiraCredential('acme.example', { ...ANA, token: 'fake-token-new', displayName: 'Ana L.' }, env)]);
  assert.deepEqual(await jiraCredential('acme.example', env), { ...ANA, token: 'fake-token-new', displayName: 'Ana L.' });
});
