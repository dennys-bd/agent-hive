import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_EVENTS, hookCommand, prepareHiveDir, renderHooksSettings, statusCommand } from '../src/hooks-settings.js';

test('hookCommand posts stdin to the hive with the worker header and never fails the hook', () => {
  const cmd = hookCommand(4242);
  assert.match(cmd, /curl -s -m 30 -X POST http:\/\/127\.0\.0\.1:4242\/hooks\/event/);
  assert.match(cmd, /-H "x-hive-worker: \$HIVE_WORKER_ID"/);
  assert.match(cmd, /-d @-/);
  assert.match(cmd, /-d @-; exit 0$/);
  assert.doesNotMatch(cmd, />\/dev\/null/, 'the reply is how a Stop continues in place: empty = no decision');
});

test('renderHooksSettings registers every lifecycle event, Bash matcher only on PostToolUse', () => {
  const settings = renderHooksSettings(4242);
  assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.equal(HOOK_EVENTS.length, 7);
  const post = settings.hooks.PostToolUse[0] as { matcher?: string; hooks: { type: string; command: string }[] };
  assert.equal(post.matcher, 'Bash');
  const stop = settings.hooks.Stop[0] as { matcher?: string; hooks: { type: string; command: string }[] };
  assert.equal(stop.matcher, undefined);
  assert.equal(stop.hooks[0].type, 'command');
  assert.equal(stop.hooks[0].command, hookCommand(4242));
});

test('statusCommand posts the status line JSON to /hooks/status, prints the reply and never fails; renderHooksSettings ships it as statusLine', () => {
  const cmd = statusCommand(4242);
  assert.match(cmd, /curl -s -m 2 -X POST http:\/\/127\.0\.0\.1:4242\/hooks\/status/);
  assert.match(cmd, /-H "x-hive-worker: \$HIVE_WORKER_ID"/);
  assert.match(cmd, /-d @-; exit 0$/);
  assert.doesNotMatch(cmd, />\/dev\/null/, 'the reply is the line the worker shows');
  assert.deepEqual(renderHooksSettings(4242).statusLine, { type: 'command', command: cmd });
  assert.match(cmd, /-m 2 /, 'the status line stays snappy; the hook waits for the board writes (-m 30)');
});

test('prepareHiveDir creates .hive/prompts, hooks.json and excludes .hive from git', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  await mkdir(join(repo, '.git', 'info'), { recursive: true });
  const paths = await prepareHiveDir(repo, 4242);
  assert.equal(paths.hooksPath, join(repo, '.hive', 'hooks.json'));
  assert.ok((await stat(paths.promptsDir)).isDirectory());
  const written = JSON.parse(await readFile(paths.hooksPath, 'utf8'));
  assert.deepEqual(written, renderHooksSettings(4242));
  const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.hive\/$/m);
  await prepareHiveDir(repo, 4242);
  const again = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(again.match(/\.hive\//g)?.length, 1, 'exclude line is not duplicated');
});

test('prepareHiveDir works in a folder without .git', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'hive-'));
  const paths = await prepareHiveDir(repo, 1);
  assert.ok((await stat(paths.hooksPath)).isFile());
});
