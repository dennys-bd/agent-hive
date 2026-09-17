import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const HIVE_DIR = '.hive';
export const HOOK_EVENTS: readonly string[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
];

const HOOK_TIMEOUT_S = 30; // a Stop is answered after the board writes of its dispatch (gh takes seconds); the reply is the continuation
const STATUS_TIMEOUT_S = 2;

function postStdin(port: number, path: string, timeout: number): string {
  return [
    `curl -s -m ${timeout} -X POST http://127.0.0.1:${port}${path}`,
    `-H "x-hive-worker: $HIVE_WORKER_ID"`,
    `-H 'content-type: application/json'`,
    `-d @-`,
  ].join(' ');
}

/** The hook command: stdout is what Claude Code reads. Empty (204) means no decision; the JSON of a continuing Stop is the decision. */
export function hookCommand(port: number): string {
  return `${postStdin(port, '/hooks/event', HOOK_TIMEOUT_S)}; exit 0`;
}

/** The worker's status line: the Hive replies with the plan limits summary, which is what the worker's tab shows. */
export function statusCommand(port: number): string {
  return `${postStdin(port, '/hooks/status', STATUS_TIMEOUT_S)}; exit 0`;
}

export function renderHooksSettings(port: number): { hooks: Record<string, unknown[]>; statusLine: { type: 'command'; command: string } } {
  const command = hookCommand(port);
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [{ ...(event === 'PostToolUse' ? { matcher: 'Bash' } : {}), hooks: [{ type: 'command', command }] }],
    ]),
  );
  // --settings precedence replaces the user's own status line inside the workers; the reply keeps the tab useful
  return { hooks, statusLine: { type: 'command', command: statusCommand(port) } };
}

async function excludeFromGit(repo: string): Promise<void> {
  const infoDir = join(repo, '.git', 'info');
  try {
    if (!(await stat(infoDir)).isDirectory()) return;
  } catch {
    return;
  }
  const excludePath = join(infoDir, 'exclude');
  const current = await readFile(excludePath, 'utf8').catch(() => '');
  if (current.split('\n').includes(`${HIVE_DIR}/`)) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(excludePath, `${separator}${HIVE_DIR}/\n`);
}

export async function prepareHiveDir(repo: string, port: number): Promise<{ hiveDir: string; hooksPath: string; promptsDir: string }> {
  const hiveDir = join(repo, HIVE_DIR);
  const promptsDir = join(hiveDir, 'prompts');
  const hooksPath = join(hiveDir, 'hooks.json');
  await mkdir(promptsDir, { recursive: true });
  await writeFile(hooksPath, `${JSON.stringify(renderHooksSettings(port), null, 2)}\n`);
  await excludeFromGit(repo);
  return { hiveDir, hooksPath, promptsDir };
}
