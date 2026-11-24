// A workspace on the distro (#948 decision 14), through the server's own start path, and the MCP half of the relay (decision 13): the task
// starts, gets a worktree on the distro's disk, runs its setup, and the lane's claude reaches the Hive through the relay with a hook and
// with MCP. The subtests run in order on one server, each a criterion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../../src/activities.js';
import { PROMPTS_DIR } from '../../src/hooks-settings.js';
import type { Machine } from '../../src/machine.js';
import type { Activity, Worker } from '../../src/types.js';
import { worktreePath } from '../../src/worktree.js';
import { bootHive, distroWorkspace, type LaneHive, SETUP_FILE } from './hive-rig.js';
import { hiveFolderOf, realWsl, stdoutOf, within } from './real-wsl.js';

const START_MS = 150_000; // the plugin's copy into the distro, the worktree and the setup, over WSL 1's slower disk
const STEP_MS = 60_000;
const LOG_TAIL = 60;
const MCP_FILE_MAX = 64 * 1024;
const MCP_ACCEPT = 'accept: application/json, text/event-stream'; // what the Streamable HTTP transport asks of every POST
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hive-wsl-lane', version: '0.0.0' } } };
const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

interface McpEntry { url: string; headers: Record<string, string> }

function activityNow(hive: LaneHive): Activity | undefined {
  const state = hive.server.getState();
  const itemId = state?.tasks[0]?.item.itemId;
  return state === undefined || itemId === undefined ? undefined : activityOf(state, itemId);
}

function workerNow(hive: LaneHive): Worker | undefined {
  const activity = activityNow(hive);
  return activity === undefined ? undefined : hive.server.getState()?.workers.find((w) => w.activityId === activity.id);
}

// The worker's MCP config, as the distro's pty wrote it: the relay's URL and the headers claude would send
async function mcpEntry(machine: Machine, ptyId: string): Promise<McpEntry> {
  const path = machine.paths.join(await hiveFolderOf(machine), PROMPTS_DIR, `${ptyId}.mcp.json`);
  const parsed = JSON.parse(await machine.fs.readFile(path, { maxBytes: MCP_FILE_MAX, encoding: 'utf8' })) as { mcpServers?: { hive?: Partial<McpEntry> } };
  const hive = parsed.mcpServers?.hive;
  assert.ok(hive?.url !== undefined && hive.headers !== undefined, `no hive server in ${path}`);
  return { url: hive.url, headers: hive.headers };
}

// curl from inside the distro: every value an argv word of its own, no shell
async function mcpPost(machine: Machine, entry: McpEntry, message: unknown): Promise<unknown> {
  const headers = Object.entries(entry.headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`]);
  const args = ['-sS', '-f', '-m', '30', '--noproxy', '*', '-X', 'POST', entry.url, '-H', 'content-type: application/json', '-H', MCP_ACCEPT, ...headers, '-d', JSON.stringify(message)];
  return JSON.parse(await stdoutOf(machine, 'curl', args));
}

test('a workspace on the distro: its task starts, gets a worktree on the distro\'s disk, runs its setup and its agent reaches the Hive (#948)', async (t) => {
  const rig = realWsl(t);
  const { machine } = rig;
  const repo = await distroWorkspace(rig);
  const hive = await bootHive(t, repo);
  const explain = (): string => hive.lines.slice(-LOG_TAIL).join('\n');

  await t.test('starting the task gives a worktree on the distro\'s disk, which git worktree list inside it names', async () => {
    await within(START_MS, async () => activityNow(hive)?.worktree !== undefined, 'the activity\'s worktree', explain);
    const activity = activityNow(hive)!;
    assert.ok(activity.slug !== undefined, 'the activity\'s slug'); // optional on Activity: only a task activity has one
    assert.equal(activity.worktree, worktreePath(machine.paths, repo, activity.slug));
    const listed = await stdoutOf(machine, 'git', ['worktree', 'list', '--porcelain'], { cwd: repo });
    assert.ok(listed.split('\n').includes(`worktree ${activity.worktree}`), listed);
  });

  await t.test('the setup RUN line runs in that worktree: its file appears there', async () => {
    const file = machine.paths.join(activityNow(hive)!.worktree!, SETUP_FILE);
    await within(STEP_MS, async () => (await machine.fs.stat(file).then((s) => s.isFile(), () => false)), `${file}`, explain);
  });

  await t.test('the hook the agent runs inside the distro reaches the Hive through the relay, seen in the run\'s state', async () => {
    await within(STEP_MS, async () => workerNow(hive)?.lastEvent?.kind === 'prompt', 'the UserPromptSubmit hook', explain);
    assert.notEqual(workerNow(hive)?.seenAt, undefined);
  });

  await t.test('an MCP initialize and a tools/list posted from the distro to the relay with the worker\'s headers answer the Hive\'s tools', async () => {
    const ptyId = workerNow(hive)?.runId;
    assert.ok(ptyId !== undefined, 'the task\'s run');
    const entry = await mcpEntry(machine, ptyId);
    assert.notEqual(new URL(entry.url).port, new URL(hive.base).port, 'the relay\'s port, not the Hive\'s own');
    const initialized = (await mcpPost(machine, entry, INITIALIZE)) as { result?: { serverInfo?: unknown } };
    assert.notEqual(initialized.result?.serverInfo, undefined, JSON.stringify(initialized));
    const listed = (await mcpPost(machine, entry, TOOLS_LIST)) as { result?: { tools?: { name: string }[] } };
    const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
    for (const name of ['hive_done', 'hive_ask', 'hive_task']) assert.ok(names.includes(name), `${name} in ${names.join(', ')}`);
  });
});
