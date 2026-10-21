import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CONFIG_FILE } from '../src/config.js';
import { generations, LOG_FILE } from '../src/log.js';
import { type BoardEnv, FIXTURE_DIR, materializeTestConfig, readBoardEnv, readFixture, stopTestHive, testWorktrees } from './test-home.js';

const execFileAsync = promisify(execFile);
const HIVE_BIN = fileURLToPath(new URL('../../bin/hive.js', import.meta.url));
const TEST_HOME = join('.hive', 'test-home'); // under the worktree: .hive/ is already out of git
const STATE_FILE = 'state.json'; // state-store.ts keeps its name private
const HOME_MODE = 0o700; // the home holds the log, the prompts and the credentials

// The test Hive works on the branch under test (HIVE-6): the worktree this script runs in is its workspace.
async function worktreeRoot(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
  return stdout.trim();
}

// A fresh fixture each run (HIVE-6): config and state overwritten, the log dropped. credentials.json and electron/ (the window's userData)
// stay, so a run never wipes a login; prompts/ and hooks.json are rewritten by the boot anyway.
async function resetHome(home: string, workspace: string, board: BoardEnv): Promise<void> {
  await mkdir(home, { recursive: true, mode: HOME_MODE });
  const config = materializeTestConfig(await readFixture(CONFIG_FILE), { workspace, ...board });
  await writeFile(join(home, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  await copyFile(join(FIXTURE_DIR, STATE_FILE), join(home, STATE_FILE));
  await Promise.all(generations(LOG_FILE).map((name) => rm(join(home, name), { force: true })));
}

// The fresh state knows no task, so every test worktree and branch left from an earlier run, in this worktree or another, is stale.
// ponytail: this also takes the worktrees of a test Hive live in another worktree; two test Hives share one source and clash anyway.
async function dropTestWorktrees(): Promise<void> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain']);
  for (const { path, branch } of testWorktrees(stdout)) {
    await execFileAsync('git', ['worktree', 'remove', '--force', path]);
    await execFileAsync('git', ['branch', '-D', branch]);
  }
  await execFileAsync('git', ['worktree', 'prune']);
}

// bin/hive.js starts the daemon of HIVE_HOME if none answers and opens the window, exactly as `HIVE_HOME=… pnpm start` would.
function launch(home: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HIVE_BIN], { env: { ...process.env, HIVE_HOME: home }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<number> {
  const board = readBoardEnv(process.env); // first: a missing variable never touches the home
  const workspace = await worktreeRoot();
  const home = join(workspace, TEST_HOME);
  await stopTestHive(home); // a live test daemon would save its own state over the fresh copy
  await resetHome(home, workspace, board);
  await dropTestWorktrees();
  console.log(`Hive de teste: ${home}`);
  return launch(home);
}

try {
  process.exit(await main());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
