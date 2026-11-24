// The Hive of the workspace criterion (#948 decision 14): an in-process server, the shape of test/server-runs.test.ts, with the real machines
// registry, which serves wsl: ids as the distro's machines on win32, and node-pty for their ptys. Its home is tempHive's, under the
// profile's temp: RUNNER_TEMP fails the home's ACL check (#628). Its workspace is a repository inside the distro.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { nodePtySpawn } from '../../src/pty-spawn.js';
import { createServer, type HiveServer } from '../../src/server.js';
import type { SettingsBody, Workspace } from '../../src/types.js';
import { APPROVAL_MINUTES_DEFAULT, DELETE_ACTIVITY_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, SHUTDOWN_IDLE_DEFAULT, SIGNALS_DEFAULTS, WSL_MACHINE_PREFIX } from '../../src/types.js';
import { AUTH, bodyFlows, fakeLog, fakeSourceFactory, fakeSpawn, GITHUB_ENTRY, STAGES, tempHive, withToplevel, workspacesAt } from '../fakes.js';
import { hiveFetch, SECRET } from '../secret-client.js';
import { DISTRO, homeOf, type RealWsl, stdoutOf } from './real-wsl.js';

export const SETUP_FILE = 'hive-948-setup';
const EXECUTABLE = 0o755;
const GIT_IDENTITY = ['-c', 'user.name=WSL lane', '-c', 'user.email=lane@example.invalid'];

// The settings every server test saves (test/server-runs.test.ts): one GitHub source, served by the fake source factory, and one flow
const BODY: Omit<SettingsBody, 'workspaces'> = {
  prefix: 'HIVE', auth: AUTH, sources: [GITHUB_ENTRY], flows: bodyFlows(STAGES),
  onClose: 'menuBar', deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT, showGithubQuota: false, closeSessionTab: 'keep', closeStageTab: 'keep', closeSessionTabNotice: true, closeStageTabNotice: true, sleepNotice: true, sleepAutoNotice: true, sleepIdleNotice: true, sleepAllNotice: true, closeTerminalTab: 'sleep', closeTerminalTabNotice: true, defaultAgent: 'claude', theme: 'system', terminalFont: '', consoleLines: 5000, trustedDomains: [], shortcuts: {}, fileIcons: { set: 'material', scope: 'all', muted: false }, sidebarsPerView: { left: true, right: true, rightTab: true }, hiveSource: true, createIn: 'hive', notifications: { waiting: true, approval: true, pr: true, failed: true }, signals: SIGNALS_DEFAULTS, editor: { formatOnSave: { enabled: true, workspaces: 'all' }, languages: {} }, commands: [], commandSemaphores: [],
};

// The lane's claude: CI has no login, so this stands in for one. Like Claude Code it reads the hooks file --settings names and runs the
// command it gives for UserPromptSubmit with the payload on stdin; that command reads HIVE_PTY_ID and HIVE_SECRET_FILE from the run's env.
// Then it stays up, as a session does, until the server's close kills the run
const FAKE_CLAUDE = [
  '#!/bin/sh',
  'settings=',
  'while [ "$#" -gt 0 ]; do',
  '  if [ "$1" = --settings ]; then settings=$2; fi',
  '  shift',
  'done',
  `hook=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).hooks.UserPromptSubmit[0].hooks[0].command)' "$settings")`,
  `printf '%s' '{"hook_event_name":"UserPromptSubmit","prompt":"the WSL lane"}' | sh -c "$hook"`,
  'exec sleep 300', // bounded, so a run the server failed to kill still ends before the next lane's distro is gone
  '',
].join('\n');

export interface LaneHive { server: HiveServer; base: string; lines: string[] }

/** A repository inside the distro with one commit, and the lane's claude at ~/.local/bin/claude, removed after the test. Both before the
 *  server starts: its machine's helper finds the agents on its PATH and in ~/.local/bin once, for its hello. */
export async function distroWorkspace(rig: RealWsl): Promise<string> {
  const { machine } = rig;
  const repo = machine.paths.join(await rig.freshDir(), 'repo');
  const git = (args: string[]): Promise<string> => stdoutOf(machine, 'git', [...GIT_IDENTITY, ...args], { cwd: repo });
  await machine.fs.mkdir(repo);
  await git(['init', '-q']);
  await machine.fs.writeFile(machine.paths.join(repo, 'README.md'), 'the WSL lane\n');
  await git(['add', 'README.md']);
  await git(['commit', '-q', '-m', 'init']);
  const claude = machine.paths.join(await homeOf(machine), '.local', 'bin', 'claude');
  rig.removeAfter(claude);
  await machine.fs.writeFile(claude, FAKE_CLAUDE, { mode: EXECUTABLE });
  await machine.fs.chmod(claude, EXECUTABLE); // writeFile's mode is narrowed by the umask
  return repo;
}

/** The server listening, its settings saved with the workspace on the lane's distro and a setup RUN line, polled and green: the fake
 *  source's task starts in the one worker tempHive's state allows. */
export async function bootHive(t: TestContext, repo: string): Promise<LaneHive> {
  const { home } = await tempHive(t, 1);
  const { log, lines } = fakeLog();
  // exec and launchPty are the local machine's, which runs nothing here: the workspace's git and ptys are the distro machine's
  const server = createServer({ secret: SECRET, home, log, sourceFactory: fakeSourceFactory().factory, launchPty: fakeSpawn().spawn, spawnPty: nodePtySpawn, exec: withToplevel(async () => ({ stdout: '' })) });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const workspaces: Workspace[] = workspacesAt(repo).map((w) => ({ ...w, machine: `${WSL_MACHINE_PREFIX}${DISTRO}`, setup: `RUN touch ${SETUP_FILE}` }));
  const saved = await hiveFetch(`${base}/settings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' }, body: JSON.stringify({ ...BODY, workspaces }) });
  assert.equal(saved.status, 200, `${await saved.text()}\n${lines.join('\n')}`);
  await server.poll();
  await server.dispatch({ type: 'setSignal', signal: 'green' });
  return { server, base, lines };
}
