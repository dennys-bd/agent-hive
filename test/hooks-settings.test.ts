import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runners } from '../src/agents/registry.js';
import { HOOK_EVENTS, renderHooksSettings, renderMcpConfig } from '../src/agents/claude-home.js';
import { excludeFromGit, hookCommand, PROTOCOL_DIR, prepareHome, statusCommand, workspaceProtocolPaths, writeMcpConfig, writeWorkspaceProtocol } from '../src/hooks-settings.js';
import { SESSION_PROTOCOL, STAGE_PROTOCOL } from '../src/protocol.js';
import { SECRET } from './secret-client.js';
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

test('prepareHome writes hooks.json and prompts/ into the home, creating it for this user only, and nothing anywhere else', async (t) => {
  const parent = await tempDir(t, '');
  const home = join(parent, 'agent-hive'); // does not exist yet: a first boot creates it
  const paths = await prepareHome(home, 4242, [runners.claude]);
  assert.deepEqual(paths, {
    hooksPath: join(home, 'hooks.json'), promptsDir: join(home, 'prompts'),
    protocol: { stage: join(home, 'protocol', 'stage.md'), session: join(home, 'protocol', 'session.md') },
  });
  assert.deepEqual(JSON.parse(await readFile(paths.hooksPath, 'utf8')), renderHooksSettings(4242));
  assert.deepEqual(await readdir(paths.promptsDir), []);
  assert.equal((await stat(home)).mode & 0o777, 0o700, 'the home holds the log and the prompts');
  assert.deepEqual(await readdir(parent), ['agent-hive']);
  await prepareHome(home, 4343, [runners.claude]);
  assert.deepEqual(JSON.parse(await readFile(paths.hooksPath, 'utf8')), renderHooksSettings(4343), 'rewritten for the port in use');
});

test('prepareHome with no runner writes the shared files only: no hooks.json and no shim for an agent boot did not find (#924)', async (t) => {
  const home = join(await tempDir(t, ''), 'agent-hive');
  await prepareHome(home, 4242, []);
  assert.deepEqual((await readdir(home)).sort(), ['prompts', 'protocol', 'shell'], 'no plugin/: every run loads its workspace\'s render (#317)');
});

test('prepareHome writes the stage and the session protocol into <home>/protocol, for this user only, returns their paths, and a later boot rewrites them (#167)', async (t) => {
  const home = join(await tempDir(t, ''), 'agent-hive');
  const { protocol } = await prepareHome(home, 4242, [runners.claude]);
  assert.deepEqual(protocol, { stage: join(home, PROTOCOL_DIR, 'stage.md'), session: join(home, PROTOCOL_DIR, 'session.md') });
  assert.equal(await readFile(protocol.stage, 'utf8'), STAGE_PROTOCOL);
  assert.equal(await readFile(protocol.session, 'utf8'), SESSION_PROTOCOL);
  assert.equal((await stat(join(home, PROTOCOL_DIR))).mode & 0o777, 0o700, 'created with the home\'s mode');
  await writeFile(protocol.stage, 'from a previous version');
  await prepareHome(home, 4242, [runners.claude]);
  assert.equal(await readFile(protocol.stage, 'utf8'), STAGE_PROTOCOL, 'upgrading the Hive refreshes what every worker is told');
});

test('excludeFromGit adds .hive/ to the repo .git/info/exclude once, and does nothing in a folder without .git', async (t) => {
  const repo = await tempDir(t, '');
  await mkdir(join(repo, '.git', 'info'), { recursive: true });
  await excludeFromGit(repo);
  await excludeFromGit(repo);
  assert.equal((await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).match(/^\.hive\/$/gm)?.length, 1, 'exclude line is not duplicated');
  const plain = await tempDir(t, '');
  await excludeFromGit(plain);
  assert.deepEqual(await readdir(plain), [], 'no .git: nothing created');
});

test('renderMcpConfig points the hive server at /hooks/mcp with the worker id and the secret as literal headers; writeMcpConfig writes it per worker next to the prompts, 0600 (#99, #467)', async (t) => {
  assert.deepEqual(renderMcpConfig(4242, 'W1', SECRET), {
    mcpServers: { hive: { type: 'http', url: 'http://127.0.0.1:4242/hooks/mcp', headers: { 'x-hive-pty': 'W1', 'x-hive-secret': SECRET } } },
  });
  const dir = await tempDir(t, '');
  const path = await writeMcpConfig(dir, 'W1', runners.claude.mcpConfig({ port: 4242, ptyId: 'W1', secret: SECRET, withHive: true, external: [] }));
  assert.ok(path);
  assert.equal(path, join(dir, 'W1.mcp.json'), 'the path carries the worker id: pkill / pgrep find claude by it');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), renderMcpConfig(4242, 'W1', SECRET));
  assert.equal((await stat(path)).mode & 0o777, 0o600, 'it holds the secret: this user only');
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

test('writeMcpConfig with withHive false writes a config that lists no server, still named after the worker and 0600 (#587)', async (t) => {
  const dir = await tempDir(t, 'prompts-');
  const worker = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const path = await writeMcpConfig(dir, worker, runners.claude.mcpConfig({ port: 47821, ptyId: worker, secret: SECRET, withHive: false, external: [] }));
  assert.ok(path);
  assert.equal(path, join(dir, `${worker}.mcp.json`));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { mcpServers: {} });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('writeWorkspaceProtocol writes, in <home>/protocol/workspaces/<workspace>/, each protocol alone for an empty memory, then a blank line and the section otherwise (#797)', async (t) => {
  const home = await tempDir(t, 'home-');
  const paths = workspaceProtocolPaths(home, 'stage.md'); // a workspace named after a global file: its own folder, no collision
  assert.deepEqual(paths, { stage: join(home, PROTOCOL_DIR, 'workspaces', 'stage.md', 'stage.md'), session: join(home, PROTOCOL_DIR, 'workspaces', 'stage.md', 'session.md') });
  await prepareHome(home, 4242, [runners.claude]);
  assert.deepEqual(await writeWorkspaceProtocol(home, 'stage.md', ''), paths);
  assert.deepEqual([await readFile(paths.stage, 'utf8'), await readFile(paths.session, 'utf8')], [STAGE_PROTOCOL, SESSION_PROTOCOL]);
  assert.equal((await stat(join(home, PROTOCOL_DIR, 'workspaces', 'stage.md'))).mode & 0o777, 0o700, 'the home\'s mode');
  const section = '## Workspace memory\n\n### Avoid\n- [m-1] never edit dist/\n';
  await writeWorkspaceProtocol(home, 'stage.md', section);
  assert.equal((await stat(paths.stage)).mode & 0o777, 0o600, 'a file only its owner reads');
  assert.deepEqual((await readdir(dirname(paths.stage))).sort(), ['session.md', 'stage.md'], 'no temp file left');
  assert.equal(workspaceProtocolPaths(home, 'a b').stage, join(home, PROTOCOL_DIR, 'workspaces', 'a%20b', 'stage.md'));
  assert.deepEqual([await readFile(paths.stage, 'utf8'), await readFile(paths.session, 'utf8')], [`${STAGE_PROTOCOL}\n${section}`, `${SESSION_PROTOCOL}\n${section}`]);
});

test('writeMcpConfig writes no file and answers undefined for an empty config: an agent whose MCP server rides its argv (#927)', async (t) => {
  const dir = await tempDir(t, 'prompts-');
  assert.equal(await writeMcpConfig(dir, 'W1', ''), undefined);
  assert.deepEqual(await readdir(dir), []);
});
