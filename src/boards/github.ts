import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Citation } from '../cards.js';
import type { Logger } from '../log.js';
import type { Board, BoardCard, BoardConfig, BoardQuota, EpicsMode, ProjectSummary, Task } from '../types.js';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 20 * 1024 * 1024;
const ITEM_LIMIT = 200;
const PROJECT_LIMIT = 100;
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/;
const RELATION_LIMIT = 50; // ponytail: no pagination, an issue with more open blockers/sub-issues than this is under-reported
const MS_PER_SECOND = 1000;
const ARGV_MAX = 200; // the GraphQL query is long; the head names the call, the rest is noise

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

const cutArgv = (args: string[]): string => {
  const argv = args.join(' ');
  return argv.length > ARGV_MAX ? `${argv.slice(0, ARGV_MAX)}…` : argv;
};

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0];

/** Wraps a gh runner so every call leaves a debug line with argv and duration; stdout is never logged, errors rethrow untouched. */
export function loggedExec(exec: Exec, log: Logger): Exec {
  return async (args) => {
    const argv = cutArgv(args);
    const started = Date.now();
    try {
      const stdout = await exec(args);
      log.debug(`gh ${argv} ${Date.now() - started}ms ok`);
      return stdout;
    } catch (err) {
      log.debug(`gh ${argv} ${Date.now() - started}ms error: ${firstLine(err)}`);
      throw err;
    }
  };
}

interface GhField { id: string; name: string; type: string; options?: { id: string; name: string }[] }
interface GhProject { number: number; title: string; url: string; closed?: boolean }
interface GhItem {
  id: string;
  status?: string;
  title?: string;
  content?: { type?: string; number?: number; title?: string; body?: string | null; url?: string };
}
interface StatusField { id: string; options: { id: string; name: string }[] }
interface GhIssueRef { number: number; state: string }
interface GhIssueRelations { blockedBy?: { nodes: GhIssueRef[] } | null; subIssues?: { nodes: GhIssueRef[] } | null }
// One entry per alias; the repository (null) or the issue (issue: null) may be gone by the time we ask.
type GhRelationsData = Record<string, { issue: GhIssueRelations | null } | null | undefined>;
interface GhRateLimit { limit?: unknown; remaining?: unknown; reset?: unknown }

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

// owner / name / number come from the issue url; they match only [\w.-], so JSON.stringify yields safe GraphQL string literals.
function issueSelection(task: Task, alias: string): string | undefined {
  const match = ISSUE_URL.exec(task.url);
  if (!match) return undefined;
  const [, owner, name, number] = match;
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { issue(number: ${number}) {`
    + ` blockedBy(first: ${RELATION_LIMIT}) { nodes { number state } }`
    + ` subIssues(first: ${RELATION_LIMIT}) { nodes { number state } } } }`;
}

// One query for the whole queue: alias i<k> is the k-th task. Nothing to ask → undefined (no gh call).
function relationsQuery(tasks: Task[]): string | undefined {
  const selections = tasks.flatMap((task, i) => issueSelection(task, `i${i}`) ?? []);
  return selections.length > 0 ? `query { ${selections.join(' ')} }` : undefined;
}

// Issue dependencies and sub-issues that are still OPEN, in response order, without duplicates.
function openBlockers(issue: GhIssueRelations | null | undefined): string[] {
  if (!issue) return [];
  const nodes = [...(issue.blockedBy?.nodes ?? []), ...(issue.subIssues?.nodes ?? [])];
  const open = nodes.filter((n) => n.state === 'OPEN').map((n) => String(n.number));
  return [...new Set(open)];
}

// An epic is any issue with at least one sub-issue, whatever its state: the same relation GitHub shows as an epic.
const isEpic = (issue: GhIssueRelations | null | undefined): boolean => (issue?.subIssues?.nodes.length ?? 0) > 0;

async function withBlockers(cards: BoardCard[], epics: EpicsMode, exec: Exec): Promise<BoardCard[]> {
  const query = relationsQuery(cards.map((c) => c.task));
  if (!query) return cards;
  const { data } = JSON.parse(await exec(['api', 'graphql', '-f', `query=${query}`])) as { data: GhRelationsData };
  return cards.flatMap((card, i) => {
    const issue = data[`i${i}`]?.issue;
    if (epics === 'ignore' && isEpic(issue)) return []; // not a task for the Hive: only its sub-issues are
    const blockedBy = openBlockers(issue);
    return [blockedBy.length > 0 ? { ...card, task: { ...card.task, blockedBy } } : card];
  });
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// `gh api rate_limit` does not count against the quota; `reset` comes in epoch seconds. Any other shape → undefined, nothing dispatched.
async function readQuota(exec: Exec): Promise<BoardQuota | undefined> {
  const parsed = JSON.parse(await exec(['api', 'rate_limit', '--jq', '.resources.graphql'])) as GhRateLimit | null;
  const { limit, remaining, reset } = parsed ?? {};
  if (!isCount(limit) || !isCount(remaining) || !isCount(reset)) return undefined;
  return { limit, remaining, resetsAt: new Date(reset * MS_PER_SECOND).toISOString(), at: new Date().toISOString() };
}

export function createGithubBoard(
  board: GithubBoardConfig, cited: Citation[], epics: EpicsMode, exec: Exec = ghExec,
): Board {
  const { owner, number } = board;
  const base = (sub: string) => projectArgs(sub, owner, number);
  let resolved: { projectId: string; statusFieldId: string; optionIds: Record<string, string> } | undefined;

  async function resolveFields(): Promise<void> {
    const view = JSON.parse(await exec(base('view'))) as { id: string };
    const status = await fetchStatusField(owner, number, exec);
    const available = status.options.map((o) => o.name);
    const optionIds: Record<string, string> = {};
    for (const { column, by } of cited) {
      const option = status.options.find((o) => o.name === column);
      if (!option) throw new Error(`"${column}" (${by}) not found in board Status options: ${available.join(', ')}`);
      optionIds[column] = option.id;
    }
    resolved = { projectId: view.id, statusFieldId: status.id, optionIds };
  }

  async function listCards(): Promise<BoardCard[]> {
    const names = new Set(cited.map((c) => c.column));
    const { items } = JSON.parse(await exec([...base('item-list'), '--limit', String(ITEM_LIMIT)])) as { items: GhItem[] };
    const listed = items.flatMap<BoardCard>((item) => {
      const c = item.content;
      if (item.status === undefined || !names.has(item.status) || c?.type !== 'Issue' || typeof c.number !== 'number' || !c.url) return [];
      return [{ task: { itemId: item.id, id: String(c.number), title: c.title ?? item.title ?? `#${c.number}`, body: c.body ?? '', url: c.url }, column: item.status }];
    });
    return withBlockers(listed, epics, exec); // item-list carries no relations; a failed query rejects the poll, never "no blockers"
  }

  async function setColumn(itemId: string, column: string): Promise<void> {
    if (!resolved) throw new Error('board not resolved: call resolveFields() first');
    const optionId = resolved.optionIds[column];
    if (optionId === undefined) throw new Error(`"${column}" is not a column the config cites`);
    await exec(['project', 'item-edit', '--id', itemId, '--project-id', resolved.projectId, '--field-id', resolved.statusFieldId, '--single-select-option-id', optionId]);
  }

  async function setupOptions(): Promise<string[]> {
    return listStatusOptions(owner, number, exec);
  }

  return { resolveFields, listCards, setColumn, setupOptions, quota: () => readQuota(exec) };
}
