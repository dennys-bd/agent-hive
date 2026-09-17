import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from './types.js';

const execFileAsync = promisify(execFile);
const NO_MATCH_EXIT = 1;

export interface WorkerCommandOptions {
  repo: string;
  workerId: string;
  port: number;
  slug: string;
  hooksPath: string;
  promptPath: string;
  claudeArgs: string[];
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

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function workerCommand(o: WorkerCommandOptions): string {
  const args = o.claudeArgs.map(shellQuote).join(' ');
  return [
    `cd ${shellQuote(o.repo)} &&`,
    `HIVE_WORKER_ID=${o.workerId} HIVE_PORT=${o.port} claude --worktree=${o.slug}`,
    `--settings ${shellQuote(o.hooksPath)}${args ? ` ${args}` : ''}`,
    `"$(cat ${shellQuote(o.promptPath)})";`,
    `curl -s -m 2 -X POST http://127.0.0.1:${o.port}/hooks/exit -H 'x-hive-worker: ${o.workerId}' >/dev/null`,
  ].join(' ');
}

const ITERM_APP_ID = 'com.googlecode.iterm2';

const OPEN_TAB_SCRIPT = `
on run argv
  tell application id "${ITERM_APP_ID}"
    activate
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current tab of current window
      write text (item 1 of argv)
      return unique id
    end tell
  end tell
end run`;

async function osascript(script: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script, ...args]);
  return stdout.trim();
}

export async function openWorker(command: string): Promise<string> {
  return osascript(OPEN_TAB_SCRIPT, command);
}

function worktreePattern(slug: string): string {
  return `--worktree=${slug}`;
}

/** Resolves true when pkill matched a process, false when nothing matched. */
export async function killWorker(slug: string): Promise<boolean> {
  try {
    await execFileAsync('pkill', ['-f', '--', worktreePattern(slug)]);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code !== NO_MATCH_EXIT) throw err;
    return false;
  }
}
