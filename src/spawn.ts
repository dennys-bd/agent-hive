import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { SpawnWorker, Task } from './types.js';

const execFileAsync = promisify(execFile);
const NO_MATCH_EXIT = 1;

export interface WorkerArgvOptions {
  slug: string;
  hooksPath: string;
  claudeArgs: string[]; // where the user sets the permission mode: print mode has no permission prompt
}

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

/** Print mode with JSON on both ends of stdio: the session stays open until stdin closes, so follow-ups still work. */
export function workerArgv(o: WorkerArgvOptions): string[] {
  return [
    `--worktree=${o.slug}`, '--settings', o.hooksPath,
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ...o.claudeArgs,
  ];
}

/** The child's env: the Hive's own minus CLAUDECODE (a Hive launched from inside Claude Code would stop the child from starting). */
export function workerEnv(base: NodeJS.ProcessEnv, workerId: string, port: number): NodeJS.ProcessEnv {
  const { CLAUDECODE: _inherited, ...env } = base;
  return { ...env, HIVE_WORKER_ID: workerId, HIVE_PORT: String(port) };
}

export function userMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

export const spawnWorker: SpawnWorker = (argv, { cwd, env }, handlers) => {
  const child = spawn('claude', argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    handlers.onExit();
  };
  createInterface({ input: child.stdout }).on('line', (line) => handlers.onLine(line));
  createInterface({ input: child.stderr }).on('line', (line) => handlers.onLine(`stderr: ${line}`));
  child.on('exit', exitOnce);
  child.on('error', (err) => {
    // claude not on PATH, or the signal failed: shown in the panel, and the worker is over either way
    handlers.onLine(`stderr: ${err.message}`);
    exitOnce();
  });
  child.stdin.on('error', (err) => handlers.onLine(`stderr: stdin: ${err.message}`)); // EPIPE after the child died: exit already freed the slot
  return {
    send: (text) => {
      child.stdin.write(userMessage(text));
    },
    end: () => {
      child.stdin.end();
    },
    kill: () => {
      child.kill('SIGTERM');
    },
  };
};

/** Boot-only orphan defense: kills a worker of a previous Hive that may still hold the worktree. Resolves true when pkill matched. */
export async function killStray(slug: string): Promise<boolean> {
  try {
    await execFileAsync('pkill', ['-f', '--', `--worktree=${slug}`]);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code !== NO_MATCH_EXIT) throw err;
    return false;
  }
}
