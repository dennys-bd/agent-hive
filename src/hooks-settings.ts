import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const HIVE_DIR = '.hive';
export const HOOK_EVENTS: readonly string[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
];

export function hookCommand(port: number): string {
  return [
    `curl -s -m 2 -X POST http://127.0.0.1:${port}/hooks/event`,
    `-H "x-hive-worker: $HIVE_WORKER_ID"`,
    `-H 'content-type: application/json'`,
    `-d @- >/dev/null; exit 0`,
  ].join(' ');
}

export function renderHooksSettings(port: number): { hooks: Record<string, unknown[]> } {
  const command = hookCommand(port);
  const hooks = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      [{ ...(event === 'PostToolUse' ? { matcher: 'Bash' } : {}), hooks: [{ type: 'command', command }] }],
    ]),
  );
  return { hooks };
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
  await writeFile(hooksPath, JSON.stringify(renderHooksSettings(port), null, 2) + '\n');
  await excludeFromGit(repo);
  return { hiveDir, hooksPath, promptsDir };
}
