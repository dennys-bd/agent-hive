import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Board, BoardConfig, ProjectSummary, StatusKey, Task } from '../types.js';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 20 * 1024 * 1024;
const ITEM_LIMIT = 200;
const PROJECT_LIMIT = 100;
const STATUS_KEYS: StatusKey[] = ['queue', 'working', 'review'];

export type Exec = (args: string[]) => Promise<string>;
export type GithubBoardConfig = Extract<BoardConfig, { type: 'github' }>;

export const ghExec: Exec = async (args) => {
  try {
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: GH_MAX_BUFFER });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${(e.stderr ?? '').trim() || e.message}`);
  }
};

interface GhField { id: string; name: string; type: string; options?: { id: string; name: string }[] }
interface GhProject { number: number; title: string; url: string; closed?: boolean }
interface GhItem {
  id: string;
  status?: string;
  title?: string;
  content?: { type?: string; number?: number; title?: string; body?: string | null; url?: string };
}
interface StatusField { id: string; options: { id: string; name: string }[] }

function projectArgs(sub: string, owner: string, number: number): string[] {
  return ['project', sub, String(number), '--owner', owner, '--format', 'json'];
}

async function fetchStatusField(owner: string, number: number, exec: Exec): Promise<StatusField> {
  const { fields } = JSON.parse(await exec(projectArgs('field-list', owner, number))) as { fields: GhField[] };
  const status = fields.find((f) => f.name === 'Status' && f.options);
  if (!status?.options) throw new Error('board has no single-select "Status" field');
  return { id: status.id, options: status.options };
}

export async function listProjects(owner: string, exec: Exec = ghExec): Promise<ProjectSummary[]> {
  const { projects } = JSON.parse(
    await exec(['project', 'list', '--owner', owner, '--limit', String(PROJECT_LIMIT), '--format', 'json']),
  ) as { projects: GhProject[] };
  return projects.filter((p) => !p.closed).map(({ number, title, url }) => ({ number, title, url }));
}

export async function listStatusOptions(owner: string, number: number, exec: Exec = ghExec): Promise<string[]> {
  return (await fetchStatusField(owner, number, exec)).options.map((o) => o.name);
}

export function createGithubBoard(board: GithubBoardConfig, statusNames: Record<StatusKey, string>, exec: Exec = ghExec): Board {
  const { owner, number } = board;
  const base = (sub: string) => projectArgs(sub, owner, number);
  let resolved: { projectId: string; statusFieldId: string; optionIds: Record<StatusKey, string> } | undefined;

  async function resolveFields(): Promise<void> {
    const view = JSON.parse(await exec(base('view'))) as { id: string };
    const status = await fetchStatusField(owner, number, exec);
    const available = status.options.map((o) => o.name);
    const optionIds = {} as Record<StatusKey, string>;
    for (const key of STATUS_KEYS) {
      const wanted = statusNames[key];
      const option = status.options.find((o) => o.name === wanted);
      if (!option) throw new Error(`status.${key} "${wanted}" not found in board Status options: ${available.join(', ')}`);
      optionIds[key] = option.id;
    }
    resolved = { projectId: view.id, statusFieldId: status.id, optionIds };
  }

  async function listQueue(): Promise<Task[]> {
    const { items } = JSON.parse(await exec([...base('item-list'), '--limit', String(ITEM_LIMIT)])) as { items: GhItem[] };
    return items.flatMap<Task>((item) => {
      const c = item.content;
      if (item.status !== statusNames.queue || c?.type !== 'Issue' || typeof c.number !== 'number' || !c.url) return [];
      return [{ itemId: item.id, id: String(c.number), title: c.title ?? item.title ?? `#${c.number}`, body: c.body ?? '', url: c.url }];
    });
  }

  async function setStatus(itemId: string, key: StatusKey): Promise<void> {
    if (!resolved) throw new Error('board not resolved: call resolveFields() first');
    await exec([
      'project', 'item-edit', '--id', itemId, '--project-id', resolved.projectId,
      '--field-id', resolved.statusFieldId, '--single-select-option-id', resolved.optionIds[key],
    ]);
  }

  async function setupOptions(): Promise<string[]> {
    return listStatusOptions(owner, number, exec);
  }

  return { resolveFields, listQueue, setStatus, setupOptions };
}
