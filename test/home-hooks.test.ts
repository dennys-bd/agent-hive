import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runners } from '../src/agents/registry.js';
import { renderMcpConfig, renderHooksSettings } from '../src/agents/claude-home.js';
import { PROTOCOL_DIR, workspaceProtocolPaths } from '../src/hooks-settings.js';
import { prepareHome, readProtocolText, writeMcpConfig, writeWorkspaceProtocol } from '../src/home-hooks.js';
import { LOCAL_PROTOCOL, protocolTexts, renderProtocol, SESSION_PROTOCOL, STAGE_PROTOCOL } from '../src/protocol.js';
import { SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';
import { assertMode } from './posix-only.js';

test('prepareHome writes hooks.json and prompts/ into the home, creating it for this user only, and nothing anywhere else', async (t) => {
  const parent = await tempDir(t, '');
  const home = join(parent, 'agent-hive'); // does not exist yet: a first boot creates it
  const paths = await prepareHome(home, 4242, [runners.claude], []);
  assert.deepEqual(paths, {
    hooksPath: join(home, 'hooks.json'), promptsDir: join(home, 'prompts'),
    protocol: { stage: join(home, 'protocol', 'stage.md'), session: join(home, 'protocol', 'session.md'), local: join(home, 'protocol', 'local.md') },
  });
  assert.deepEqual(JSON.parse(await readFile(paths.hooksPath, 'utf8')), renderHooksSettings(4242));
  assert.deepEqual(await readdir(paths.promptsDir), []);
  await assertMode(t, home, 0o700, 'the home holds the log and the prompts'); // win32: no POSIX mode bits
  assert.deepEqual(await readdir(parent), ['agent-hive']);
  await prepareHome(home, 4343, [runners.claude], []);
  assert.deepEqual(JSON.parse(await readFile(paths.hooksPath, 'utf8')), renderHooksSettings(4343), 'rewritten for the port in use');
});

test('prepareHome with no runner writes the shared files only: no hooks.json and no shim for an agent boot did not find (#924)', async (t) => {
  const home = join(await tempDir(t, ''), 'agent-hive');
  await prepareHome(home, 4242, [], []);
  assert.deepEqual((await readdir(home)).sort(), ['prompts', 'protocol', 'shell'], 'no plugin/: every run loads its workspace\'s render (#317)');
});

test('prepareHome writes the stage and the session protocol into <home>/protocol, for this user only, returns their paths, and a later boot rewrites them (#167)', async (t) => {
  const home = join(await tempDir(t, ''), 'agent-hive');
  const { protocol } = await prepareHome(home, 4242, [runners.claude], []);
  assert.deepEqual(protocol, { stage: join(home, PROTOCOL_DIR, 'stage.md'), session: join(home, PROTOCOL_DIR, 'session.md'), local: join(home, PROTOCOL_DIR, 'local.md') });
  assert.equal(await readFile(protocol.stage, 'utf8'), STAGE_PROTOCOL);
  assert.equal(await readFile(protocol.session, 'utf8'), SESSION_PROTOCOL);
  assert.equal(await readFile(protocol.local, 'utf8'), LOCAL_PROTOCOL);
  await assertMode(t, join(home, PROTOCOL_DIR), 0o700, 'created with the home\'s mode'); // win32: no POSIX mode bits
  await writeFile(protocol.stage, 'from a previous version');
  await prepareHome(home, 4242, [runners.claude], []);
  assert.equal(await readFile(protocol.stage, 'utf8'), STAGE_PROTOCOL, 'upgrading the Hive refreshes what every worker is told');
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
  await assertMode(t, path, 0o600, 'it holds the secret: this user only'); // win32: no POSIX mode bits
});

test('writeMcpConfig with withHive false writes a config that lists no server, still named after the worker and 0600 (#587)', async (t) => {
  const dir = await tempDir(t, 'prompts-');
  const worker = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const path = await writeMcpConfig(dir, worker, runners.claude.mcpConfig({ port: 47821, ptyId: worker, secret: SECRET, withHive: false, external: [] }));
  assert.ok(path);
  assert.equal(path, join(dir, `${worker}.mcp.json`));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { mcpServers: {} });
  await assertMode(t, path, 0o600); // win32: no POSIX mode bits
});

test('writeWorkspaceProtocol writes, in <home>/protocol/workspaces/<workspace>/, each protocol alone for an empty memory, then a blank line and the section otherwise (#797)', async (t) => {
  const home = await tempDir(t, 'home-');
  const paths = workspaceProtocolPaths(home, 'stage.md'); // a workspace named after a global file: its own folder, no collision
  assert.deepEqual(paths, { stage: join(home, PROTOCOL_DIR, 'workspaces', 'stage.md', 'stage.md'), session: join(home, PROTOCOL_DIR, 'workspaces', 'stage.md', 'session.md'), local: join(home, PROTOCOL_DIR, 'workspaces', 'stage.md', 'local.md') });
  await prepareHome(home, 4242, [runners.claude], []);
  assert.deepEqual(await writeWorkspaceProtocol(home, 'stage.md', protocolTexts([], []), ''), paths);
  assert.deepEqual([await readFile(paths.stage, 'utf8'), await readFile(paths.session, 'utf8')], [STAGE_PROTOCOL, SESSION_PROTOCOL]);
  await assertMode(t, join(home, PROTOCOL_DIR, 'workspaces', 'stage.md'), 0o700, 'the home\'s mode'); // win32: no POSIX mode bits
  const section = '## Workspace memory\n\n### Avoid\n- [m-1] never edit dist/\n';
  await writeWorkspaceProtocol(home, 'stage.md', protocolTexts([], []), section);
  await assertMode(t, paths.stage, 0o600, 'a file only its owner reads'); // win32: no POSIX mode bits
  assert.deepEqual((await readdir(dirname(paths.stage))).sort(), ['local.md', 'session.md', 'stage.md'], 'no temp file left');
  assert.equal(workspaceProtocolPaths(home, 'a b').stage, join(home, PROTOCOL_DIR, 'workspaces', 'a%20b', 'stage.md'));
  assert.deepEqual([await readFile(paths.stage, 'utf8'), await readFile(paths.session, 'utf8')], [`${STAGE_PROTOCOL}\n${section}`, `${SESSION_PROTOCOL}\n${section}`]);
});

test('writeMcpConfig writes no file and answers undefined for an empty config: an agent whose MCP server rides its argv (#927)', async (t) => {
  const dir = await tempDir(t, 'prompts-');
  assert.equal(await writeMcpConfig(dir, 'W1', ''), undefined);
  assert.deepEqual(await readdir(dir), []);
});

test('prepareHome writes the global protocol files without the block of a tool turned off and with no passage: there is no workspace to render one for (#336)', async (t) => {
  const home = join(await tempDir(t, ''), 'agent-hive');
  await mkdir(join(home, PROTOCOL_DIR, 'passages'), { recursive: true });
  await writeFile(join(home, PROTOCOL_DIR, 'passages', 'p1.md.liquid'), '---\nafter: ask\n---\nA passage.\n');
  const { protocol } = await prepareHome(home, 4242, [], ['hive_remember']);
  assert.deepEqual([await readFile(protocol.stage, 'utf8'), await readFile(protocol.session, 'utf8')], [renderProtocol('stage', ['hive_remember'], []), renderProtocol('session', ['hive_remember'], [])]);
  assert.equal((await readFile(protocol.stage, 'utf8')).includes('hive_remember'), false);
});

test('writeWorkspaceProtocol writes the texts it is given, the memory section under each (#336)', async (t) => {
  const home = await tempDir(t, 'home-');
  const paths = await writeWorkspaceProtocol(home, 'site', { stage: 'S\n', session: 'C\n', local: 'L\n' }, '## Workspace memory\n');
  assert.deepEqual([await readFile(paths.stage, 'utf8'), await readFile(paths.session, 'utf8')], ['S\n\n## Workspace memory\n', 'C\n\n## Workspace memory\n']);
});

test('the global and every workspace\'s writer write local.md beside the other two, a turned-off tool\'s block left out, the workspace\'s memory section under it (#256)', async (t) => {
  const home = join(await tempDir(t, ''), 'agent-hive');
  const { protocol } = await prepareHome(home, 4242, [], ['hive_remember']);
  assert.deepEqual([protocol.local, await readFile(protocol.local, 'utf8')], [join(home, PROTOCOL_DIR, 'local.md'), renderProtocol('local', ['hive_remember'], [])]);
  const paths = await writeWorkspaceProtocol(home, 'site', protocolTexts([], []), '## Workspace memory\n');
  assert.deepEqual(paths, workspaceProtocolPaths(home, 'site'));
  assert.equal(paths.local, join(home, PROTOCOL_DIR, 'workspaces', 'site', 'local.md'));
  assert.equal(await readFile(paths.local, 'utf8'), `${LOCAL_PROTOCOL}\n## Workspace memory\n`);
  await assertMode(t, paths.local, 0o600, 'it holds the lessons, as the other two do'); // win32: no POSIX mode bits
});

test('readProtocolText answers a protocol file\'s text and rejects one that cannot be read, so the run fails before any pty (#159, #927)', async (t) => {
  const home = await tempDir(t, 'home-');
  const { protocol } = await prepareHome(home, 4242, [], []);
  assert.equal(await readProtocolText(protocol.stage), await readFile(protocol.stage, 'utf8'));
  await assert.rejects(readProtocolText(join(home, 'gone.md')), { code: 'ENOENT' });
});
