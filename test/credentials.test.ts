import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { credentialsPath, readCredentials, writeCredentials } from '../src/credentials.js';
import { tempDir, type AfterHost } from './temp-dir.js';

const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const MODE_MASK = 0o777;

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
  assert.equal((await stat(path)).mode & MODE_MASK, OWNER_ONLY_FILE);
  assert.equal((await stat(dirname(path))).mode & MODE_MASK, OWNER_ONLY_DIR);
});

test('a pre-planted file at the old fixed temp-file name is never written through: the real temp name is unique', async (t) => {
  const env = await configHome(t);
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, 'planted', { mode: 0o666 }); // the fixed name a previous implementation reused
  await writeCredentials({ github: { token: 'gho_x', login: 'ana' } }, env);
  assert.equal((await stat(path)).mode & MODE_MASK, OWNER_ONLY_FILE, 'credentials.json got its own 0600, not the planted file\'s mode');
  assert.deepEqual(await readCredentials(env), { github: { token: 'gho_x', login: 'ana' } });
});
