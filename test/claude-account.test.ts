import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADD_TIMEOUT_MS, type ClaudeAdd, createClaudeAdd, CURSOR_ANSWER, nameRefusal, plainScreen, SETUP_TOKEN_COLS, SETUP_TOKEN_ROWS, tokenFrom, trimmedName, urlFrom,
} from '../src/claude-account.js';
import { type ClaudeCredential, credentialsPath, readCredentials, saveClaudeCredential } from '../src/credentials.js';
import { NO_PTY } from '../src/pty-host.js';
import type { ClaudeAddStatus } from '../src/types.js';
import { fakeLog, type FakePty, fakePtys } from './fakes.js';
import { assertMode } from './posix-only.js';
import { tempDir } from './temp-dir.js';

// Obviously fake and built here, so no fixture holds a token-shaped literal: 13 + 95 = 108 characters, the length the CLI prints
const TOKEN = `sk-ant-oat01-${'x'.repeat(95)}`;
const SIGN_IN_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=fake-955';
const SAVED = "Store this token securely. You won't be able to see it again.";

interface Harness { add: ClaudeAdd; ptys: FakePty[]; lines: string[]; env: NodeJS.ProcessEnv; saves: Promise<void>[] }

// One add over a temp config home; every store it asks for lands in `saves`, so a test can await the one in flight
async function harness(t: TestContext, save?: (name: string, cred: ClaudeCredential) => Promise<void>): Promise<Harness> {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'claude-add-') };
  const { log, lines } = fakeLog();
  const { spawnPty, ptys } = fakePtys();
  const saves: Promise<void>[] = [];
  const store = save ?? ((name: string, cred: ClaudeCredential) => saveClaudeCredential(name, cred, env));
  const add = createClaudeAdd({
    spawnPty, command: 'claude-test', env: { LANG: 'C' }, cwd: env.XDG_CONFIG_HOME, log,
    save: (name, cred) => {
      const done = store(name, cred);
      saves.push(done);
      return done;
    },
  });
  t.after(() => add.close());
  return { add, ptys, lines, env, saves };
}

// Names are not secrets; the token, the URL and the screen may hold what the CLI printed
function assertClean(h: Harness): void {
  for (const line of h.lines) {
    assert.ok(!line.includes('sk-ant-oat01-'), line);
    assert.ok(!line.includes('https://'), line);
    assert.ok(!line.includes('Store this token'), line);
  }
}

test('plainScreen turns every escape, \\r and \\n into a space, never deleting one (#955)', () => {
  assert.equal(plainScreen('a\x1b[1mb\x1b]8;;https://e.test\x07c\r\nd\x1b(Be'), 'a b c  d e');
});

test('tokenFrom answers the first run of at least 80 characters a boundary ends, and nothing while the run ends the buffer (#955)', () => {
  assert.equal(tokenFrom(plainScreen(`token: ${TOKEN}`)), undefined, 'a run that touches the end may still be arriving');
  assert.equal(tokenFrom(plainScreen(`token: ${TOKEN}\r\n`)), TOKEN);
  assert.equal(tokenFrom(plainScreen(`${TOKEN}\x1b[0m`)), TOKEN);
  assert.equal(tokenFrom(`sk-ant-oat01-short ${TOKEN} `), TOKEN, 'a run under 80 characters is no token');
  const mixed = `sk-ant-oat01-${'aZ9_-'.repeat(19)}`;
  assert.equal(tokenFrom(`${mixed} `), mixed);
  assert.equal(tokenFrom(`sk-ant-api03-${'x'.repeat(95)} `), undefined, 'only an OAuth token');
});

test('urlFrom answers the first https run up to a boundary (#955)', () => {
  assert.equal(urlFrom(plainScreen(`open ${SIGN_IN_URL}\r\n`)), SIGN_IN_URL);
  assert.equal(urlFrom(plainScreen(`open ${SIGN_IN_URL}`)), undefined);
  assert.equal(urlFrom('http://plain.test '), undefined);
});

test('a name is trimmed, and refused empty, over 40 characters, as add in any case or equal to a stored one in another case (#955)', () => {
  for (const raw of ['', '   ', 42, undefined, null]) assert.equal(nameRefusal(raw, []), 'name-empty', String(raw));
  assert.equal(nameRefusal('x'.repeat(41), []), 'name-too-long');
  assert.equal(nameRefusal(` ${'x'.repeat(40)} `, []), undefined, 'trimmed before it is measured');
  assert.equal(nameRefusal('ANA', ['ana']), 'name-taken');
  for (const raw of ['add', 'Add', ' ADD ']) assert.equal(nameRefusal(raw, []), 'name-taken', raw);
  assert.equal(nameRefusal('ana / work', ['bob']), undefined, 'any character');
  assert.equal(trimmedName('  ana '), 'ana');
  assert.equal(trimmedName(7), '');
});

test('a sign-in URL then a token split across two chunks: pending with the URL, then connected, the token stored at 0600 (#955)', async (t) => {
  const h = await harness(t);
  const seen: ClaudeAddStatus[] = [];
  const started = h.add.start('ana');
  assert.deepEqual(started, { state: 'pending', name: 'ana' });
  const [pty] = h.ptys;
  assert.equal(pty.file, 'claude-test');
  assert.deepEqual(pty.args, ['setup-token']);
  assert.deepEqual([pty.options.cols, pty.options.rows], [SETUP_TOKEN_COLS, SETUP_TOKEN_ROWS]);
  assert.deepEqual([SETUP_TOKEN_COLS, SETUP_TOKEN_ROWS], [512, 50]);
  assert.deepEqual(pty.options.env, { LANG: 'C' });
  assert.equal(pty.options.cwd, h.env.XDG_CONFIG_HOME);
  pty.emit(`\x1b[2J\x1b[1;1HBrowser didn't open? Use the url below to sign in:\r\n\r\n${SIGN_IN_URL}\r\n\r\n`);
  seen.push(h.add.status());
  assert.deepEqual(h.add.status(), { state: 'pending', name: 'ana', url: SIGN_IN_URL });
  pty.emit(`\x1b[32m${TOKEN.slice(0, 60)}`);
  seen.push(h.add.status());
  assert.equal(h.add.status().state, 'pending', 'the run ends the buffer: more of it may come');
  assert.equal(pty.killed, 0);
  pty.emit(`${TOKEN.slice(60)}\x1b[39m\r\n\r\n${SAVED}\r\n`);
  assert.equal(pty.killed, 1, 'nothing more is wanted from the CLI once the token is read');
  await h.saves[0];
  seen.push(h.add.status());
  assert.deepEqual(h.add.status(), { state: 'connected', name: 'ana' });
  assert.deepEqual((await readCredentials(h.env)).claude, { ana: { token: TOKEN } });
  await assertMode(t, credentialsPath(h.env), 0o600);
  for (const status of [started, ...seen]) assert.ok(!JSON.stringify(status).includes('sk-ant-oat01-'), 'no status holds the token');
  assert.ok(h.lines.includes('INFO claude account add started: ana'), h.lines.join('\n'));
  assert.ok(h.lines.includes('INFO claude account add connected: ana'), h.lines.join('\n'));
  assertClean(h);
});

test('the cursor query is answered with row 1, column 1, so the CLI draws (#955)', async (t) => {
  const h = await harness(t);
  h.add.start('ana');
  h.ptys[0].emit('\x1b[6n');
  assert.deepEqual(h.ptys[0].written, [CURSOR_ANSWER]);
  assert.equal(CURSOR_ANSWER, '\x1b[1;1R');
});

test('a second start while one is pending answers undefined and the first goes on (#955)', async (t) => {
  const h = await harness(t);
  h.add.start('ana');
  assert.equal(h.add.start('bob'), undefined);
  assert.equal(h.ptys.length, 1);
  assert.equal(h.ptys[0].killed, 0);
  assert.deepEqual(h.add.status(), { state: 'pending', name: 'ana' });
});

test('cancel kills the pty, stores nothing and answers cancelled; a late token or exit changes nothing (#955)', async (t) => {
  const h = await harness(t);
  h.add.start('ana');
  const [pty] = h.ptys;
  h.add.cancel();
  assert.equal(pty.killed, 1);
  assert.deepEqual(h.add.status(), { state: 'cancelled', name: 'ana' });
  pty.emit(`${TOKEN}\r\n`);
  pty.exit(0);
  h.add.cancel(); // nothing pending: no change
  assert.deepEqual(h.add.status(), { state: 'cancelled', name: 'ana' });
  assert.equal(h.saves.length, 0);
  assert.deepEqual(await readCredentials(h.env), {});
  assert.ok(h.lines.includes('INFO claude account add cancelled: ana'), h.lines.join('\n'));
  assertClean(h);
});

test('an exit without a token answers failed exited with its code in the log, and the next add starts afresh (#955)', async (t) => {
  const h = await harness(t);
  h.add.start('ana');
  h.ptys[0].exit(1);
  assert.deepEqual(h.add.status(), { state: 'failed', name: 'ana', reason: 'exited' });
  assert.ok(h.lines.includes('WARN claude account add failed: ana (exited 1)'), h.lines.join('\n'));
  assert.deepEqual(h.add.start('bob'), { state: 'pending', name: 'bob' });
  assert.equal(h.ptys.length, 2);
  assertClean(h);
});

test('10 minutes without a token kill the pty and answer failed timeout (#955)', async (t) => {
  const h = await harness(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  h.add.start('ana');
  t.mock.timers.tick(ADD_TIMEOUT_MS - 1);
  assert.equal(h.add.status().state, 'pending');
  t.mock.timers.tick(1);
  assert.equal(h.ptys[0].killed, 1);
  assert.deepEqual(h.add.status(), { state: 'failed', name: 'ana', reason: 'timeout' });
  assert.equal(ADD_TIMEOUT_MS, 600_000);
  assert.ok(h.lines.includes('WARN claude account add failed: ana (timeout)'), h.lines.join('\n'));
});

test('a store that fails answers failed store and logs the error, never the token (#955)', async (t) => {
  const h = await harness(t, () => Promise.reject(new Error('disk full')));
  h.add.start('ana');
  h.ptys[0].emit(`${TOKEN}\r\n`);
  await h.saves[0].catch(() => undefined);
  assert.deepEqual(h.add.status(), { state: 'failed', name: 'ana', reason: 'store' });
  assert.ok(h.lines.includes('ERROR claude account ana not stored: disk full'), h.lines.join('\n'));
  assert.ok(h.lines.includes('WARN claude account add failed: ana (store)'), h.lines.join('\n'));
  assertClean(h);
});

test('a spawn that throws ends the add as failed exited at once (#955)', () => {
  const { log, lines } = fakeLog();
  const add = createClaudeAdd({ spawnPty: NO_PTY, command: 'claude', env: {}, cwd: '.', log, save: async () => undefined });
  assert.deepEqual(add.start('ana'), { state: 'failed', name: 'ana', reason: 'exited' });
  assert.deepEqual(add.status(), { state: 'failed', name: 'ana', reason: 'exited' });
  assert.ok(lines.includes('WARN claude account add failed: ana (exited, spawn: no pty in this process)'), lines.join('\n'));
});

test('close kills a pending add (#955)', async (t) => {
  const h = await harness(t);
  h.add.start('ana');
  h.add.close();
  assert.equal(h.ptys[0].killed, 1);
});
