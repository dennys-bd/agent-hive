import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOOK_EVENTS, renderHooksSettings } from '../src/agents/claude-home.js';
import { excludeFromGit, hookCommand, statusCommand } from '../src/hooks-settings.js';
import { fakeMachine } from './fakes.js';
import { tempDir } from './temp-dir.js';

test('hookCommand posts stdin to the hive with the worker header and never fails the hook', () => {
  const cmd = hookCommand(4242);
  assert.match(cmd, /curl -sf -m 30 -X POST http:\/\/127\.0\.0\.1:4242\/hooks\/event/);
  assert.match(cmd, /-H "x-hive-pty: \$HIVE_PTY_ID"/);
  assert.match(cmd, /-d @-/);
  assert.match(cmd, /-d @-; exit 0$/);
  assert.doesNotMatch(cmd, />\/dev\/null/, 'the reply is how a Stop continues in place: empty = no decision');
  assert.match(cmd, /curl -sf /, 'an HTTP error body (Express HTML, the host guard JSON) must never reach the worker context');
  assert.match(cmd, / --noproxy '\*' /, 'a proxy in the env never sees the secret header (#696)');
  assert.match(statusCommand(4242), / --noproxy '\*' /);
});

test('renderHooksSettings registers every lifecycle event, Bash matcher only on PostToolUse', () => {
  const settings = renderHooksSettings(4242);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.equal(HOOK_EVENTS.length, 8);
  const post = settings.hooks.PostToolUse[0] as { matcher?: string; hooks: { type: string; command: string }[] };
  assert.equal(post.matcher, 'Bash');
  const stop = settings.hooks.Stop[0] as { matcher?: string; hooks: { type: string; command: string }[] };
  assert.equal(stop.matcher, undefined);
  assert.equal(stop.hooks[0].type, 'command');
  assert.match(stop.hooks[0].command, /\/hooks\/event -H .*; exit 0$/, 'the same route; its timeout is the #268 test\'s');
  assert.deepEqual(settings.permissions, { allow: ['mcp__hive__*'] }, 'the hive tools never stop the worker at a permission prompt (#99)');
});

test('the Stop hook waits as long as an approval can hold it: curl -m and the hook timeout at APPROVAL_HOLD_MAX_MIN minutes plus the usual 30 s; every other event keeps -m 30 and no timeout (#268)', () => {
  const settings = renderHooksSettings(4242);
  const entry = (event: string) => (settings.hooks[event][0] as { hooks: { command: string; timeout?: number }[] }).hooks[0];
  assert.equal(entry('Stop').timeout, 7230);
  assert.match(entry('Stop').command, /^curl -sf -m 7230 -X POST http:\/\/127\.0\.0\.1:4242\/hooks\/event /);
  for (const event of HOOK_EVENTS.filter((e) => e !== 'Stop')) {
    assert.deepEqual([entry(event).command, entry(event).timeout], [hookCommand(4242), undefined], event);
  }
});

test('StopFailure is registered with the ordinary hook command and no long timeout: nothing is ever held on it (#805)', () => {
  const entry = (renderHooksSettings(4242).hooks.StopFailure[0] as { hooks: { command: string; timeout?: number }[] }).hooks[0];
  assert.deepEqual([entry.command, entry.timeout], [hookCommand(4242), undefined]);
});

test('statusCommand posts the status line JSON to /hooks/status, prints the reply and never fails; renderHooksSettings ships it as statusLine', () => {
  const cmd = statusCommand(4242);
  assert.match(cmd, /curl -sf -m 2 -X POST http:\/\/127\.0\.0\.1:4242\/hooks\/status/);
  assert.match(cmd, /-H "x-hive-pty: \$HIVE_PTY_ID"/);
  assert.match(cmd, /-d @-; exit 0$/);
  assert.doesNotMatch(cmd, />\/dev\/null/, 'the reply is the line the worker shows');
  assert.deepEqual(renderHooksSettings(4242).statusLine, { type: 'command', command: cmd });
  assert.match(cmd, /-m 2 /, 'the status line stays snappy; the hook waits for the board writes (-m 30)');
});

test('excludeFromGit adds .hive/ to the repo .git/info/exclude once, and does nothing in a folder without .git', async (t) => {
  const repo = await tempDir(t, '');
  await mkdir(join(repo, '.git', 'info'), { recursive: true });
  await excludeFromGit(fakeMachine(), repo);
  await excludeFromGit(fakeMachine(), repo);
  assert.equal((await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).match(/^\.hive\/$/gm)?.length, 1, 'exclude line is not duplicated');
  const plain = await tempDir(t, '');
  await excludeFromGit(fakeMachine(), plain);
  assert.deepEqual(await readdir(plain), [], 'no .git: nothing created');
});

test('every hook and the status line send the secret as curl\'s header file, never by value nor by an expanded variable: hooks.json is shared by every worker, and curl\'s argv is readable by every account (#467)', () => {
  const settings = renderHooksSettings(4242);
  const commands = [
    ...HOOK_EVENTS.map((event) => (settings.hooks[event][0] as { hooks: { command: string }[] }).hooks[0].command),
    settings.statusLine.command,
  ];
  for (const command of commands) {
    assert.ok(command.includes('-H @"$HIVE_SECRET_FILE"'), command);
    assert.ok(!command.includes('$HIVE_SECRET"') && !command.includes('x-hive-secret'), command);
  }
});

test('excludeFromGit reads and appends .git/info/exclude through the machine\'s fs (#159)', async (t) => {
  const repo = await tempDir(t, 'repo-');
  await mkdir(join(repo, '.git', 'info'), { recursive: true });
  const appended: [string, string][] = [];
  await excludeFromGit(fakeMachine({ fs: { appendFile: async (path, data) => { appended.push([path, String(data)]); } } }), repo);
  assert.deepEqual(appended, [[join(repo, '.git', 'info', 'exclude'), '.hive/\n']]);
});
