import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { spawnItermWorker } from './spawn-iterm.js';
import { spawnTmuxWorker } from './spawn-tmux.js';
import type { Card, Column, SessionPolicy, SpawnWorker, Task } from './types.js';

const execFileAsync = promisify(execFile);
const NO_MATCH_EXIT = 1;

export function renderPrompt(template: string, task: Task): string {
  const values: Record<string, string> = {
    id: task.id, number: task.id, title: task.title, body: task.body, url: task.url, // {number} is a synonym of {id}
  };
  return template.replace(/\{(id|number|title|body|url)\}/g, (_, key: string) => values[key]);
}

export async function writePrompt(promptsDir: string, slug: string, text: string): Promise<string> {
  const path = join(promptsDir, `${slug}.md`);
  await writeFile(path, text);
  return path;
}

/** The argv the reducer decided: the card's worktree on every run, the global claudeArgs, the column model, then the session id as
 * `--session-id` (new: the Hive generated it) or `--resume` (continue: the card's own). No id at all leaves the choice to claude. */
export function workerArgs(card: Pick<Card, 'slug' | 'sessionId'>, column: Pick<Column, 'model'>, session: SessionPolicy, claudeArgs: string[]): string[] {
  const model = column.model === undefined ? [] : ['--model', column.model];
  const id = card.sessionId === undefined ? [] : [session === 'continue' ? '--resume' : '--session-id', card.sessionId];
  return [`--worktree=${card.slug}`, ...claudeArgs, ...model, ...id];
}

/**
 * The env the worker (and the tmux server, born with its first client) gets: the Hive's own minus CLAUDECODE (a Hive
 * launched from inside Claude Code would stop the child from starting) and NODE_PATH (Electron points it at the Hive's
 * node_modules; inherited, a worker running `pnpm test` would resolve the Hive's electron and open a window that never
 * exits), plus the worker id and port.
 */
export function workerEnv(base: NodeJS.ProcessEnv, workerId: string, port: number): NodeJS.ProcessEnv {
  const { CLAUDECODE: _claudecode, NODE_PATH: _nodePath, ...env } = base;
  return { ...env, HIVE_WORKER_ID: workerId, HIVE_PORT: String(port) };
}

/** The default spawner: picks the implementation by `config.workers`. Both run an interactive claude. */
export const spawnWorker: SpawnWorker = (launch, handlers) =>
  (launch.mode === 'iterm' ? spawnItermWorker(launch, handlers) : spawnTmuxWorker(launch, handlers));

/** Boot-only orphan defense (and the tab's kill): kills a worker that may still hold the worktree. Resolves true when pkill matched. */
export async function killStray(slug: string): Promise<boolean> {
  try {
    await execFileAsync('pkill', ['-f', '--', `--worktree=${slug}`]);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code !== NO_MATCH_EXIT) throw err;
    return false;
  }
}
