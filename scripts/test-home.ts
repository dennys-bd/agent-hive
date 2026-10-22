import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from '../src/config.js';
import { type PrefixedWorktree, worktreesOn } from '../src/benchmark/git.js';
import { stopDaemon } from '../src/daemon.js';

/** The committed test home (HIVE-6). JSON is not copied to dist/, so this module, built into dist/scripts/, climbs back to the repo root;
 * the test imports this same module, so both resolve the same folder. */
export const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/test-home/', import.meta.url));

/** The sandbox board's Status options, in board order: the seed creates exactly these and the test requires the stages to cite exactly these. */
export const BOARD_COLUMNS = ['Backlog', 'Ready', 'In progress', 'In review', 'Done'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export const SANDBOX_REPO = 'hive-test-board';
export const SANDBOX_TITLE = 'Hive test board';

const OWNER_VAR = 'HIVE_TEST_BOARD_OWNER';
const NUMBER_VAR = 'HIVE_TEST_BOARD_NUMBER';
// GitHub's login shape: the owner reaches gh's argv and the repo path, so a leading `-` must never pass as a flag.
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const POSITIVE_INT = /^[1-9]\d*$/;

export interface BoardEnv { owner: string; number: number }
export interface TestHomeValues extends BoardEnv { workspace: string }

export async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURE_DIR, name), 'utf8'));
}

/** The sandbox board's owner (HIVE-6): required, no fallback, since the board is part of every run. */
export function readBoardOwner(env: NodeJS.ProcessEnv): string {
  const owner = env[OWNER_VAR]?.trim() ?? '';
  if (!GITHUB_LOGIN.test(owner)) throw new Error(`${OWNER_VAR} deve ser o login (usuário ou organização) dono do board de teste`);
  return owner;
}

/** Owner and Project number of the sandbox board (HIVE-6), checked before the script touches the home. */
export function readBoardEnv(env: NodeJS.ProcessEnv): BoardEnv {
  const owner = readBoardOwner(env);
  const number = env[NUMBER_VAR]?.trim() ?? '';
  if (!POSITIVE_INT.test(number)) throw new Error(`${NUMBER_VAR} deve ser o número do Project de teste, um inteiro positivo (pnpm seed:test-board o mostra)`);
  return { owner, number: Number(number) };
}

type Entry = Record<string, unknown>;
interface FixtureConfig { comb: { workspaces: Entry[]; sources: Entry[] } }

/** The fixture's config with its placeholders replaced (HIVE-6): the worktree as the workspace, the sandbox board's owner and number.
 * The shape is the fixture's own; parseConfig, in the test and on boot, judges the result. */
export function materializeTestConfig(raw: unknown, { workspace, owner, number }: TestHomeValues): unknown {
  const config = raw as FixtureConfig;
  const [first, ...workspaces] = config.comb.workspaces;
  const [source, ...sources] = config.comb.sources;
  return {
    ...config,
    comb: { ...config.comb, workspaces: [{ ...first, path: workspace }, ...workspaces], sources: [{ ...source, owner, number }, ...sources] },
  };
}

/** Stops the test Hive of `home` before a fresh copy. A home with no config never booted one: nothing to ask (#466: no hive.port either). */
export async function stopTestHive(home: string, stop: (home: string) => Promise<boolean> = stopDaemon): Promise<boolean> {
  return existsSync(join(home, CONFIG_FILE)) ? stop(home) : false;
}

export type TestWorktree = PrefixedWorktree;
const TEST_BRANCH_REF = 'refs/heads/hive/TEST-';

/** The worktrees holding a branch under `refPrefix` (hive/TEST- by default). Other harnesses pass their own branch prefix. */
export const testWorktrees = (porcelain: string, refPrefix: string = TEST_BRANCH_REF): TestWorktree[] => worktreesOn(porcelain, refPrefix);
