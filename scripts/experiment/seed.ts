import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugFor } from '../../src/tasks.js';
import type { Item } from '../../src/types.js';

/** Built into dist/scripts/experiment/: three levels up is the repo root, as test-home.ts climbs to its fixture. JSON is not copied to dist/. */
export const REPO_FILES = fileURLToPath(new URL('../../../', import.meta.url));
export const SEED_PATH = 'scripts/experiment/seeds/monitor-view';
export const SEED_DIR = join(REPO_FILES, SEED_PATH);
/** Where the docs baseline carries the handoff, inside the docs repository (#79); a worker reads it at docs/agent/handoff_monitor/. */
export const HANDOFF_DIR = 'agent/handoff_monitor';
/** What the code baseline drops (#105, the user): the harness and its tests. */
export const EXPERIMENT_PATHS = ['scripts/experiment', 'test/experiment'] as const;
/** What the docs baseline drops (#79): every doc naming the harness, as git grep -E reads it. The #105 spec and plan are among them, and
 *  so is any plan of another delivery that lists a harness file it touched: a worker reading it would learn of the experiment. */
export const EXPERIMENT_MENTION = 'scripts/experiment|test/experiment|skills-ab-experiment|experiment:skills';

export type StageRole = 'spec' | 'plan' | 'build';
export const STAGE_ROLES: readonly StageRole[] = ['spec', 'plan', 'build'];
export interface SeedTask { key: string; title: string; delivery: number; blockedBy: string[]; body: string }
export interface StagesSeed { claudeArgs: string[]; stages: Record<string, unknown>[] }
export interface Scenario { id: string; title: string; text: string }
export interface Artboard { id: string; file: string; title: string; delivery: number; live: boolean }
export interface Seed {
  handoff: string; tasks: SeedTask[]; stages: StagesSeed; scenarios: Scenario[]; artboards: Artboard[];
  screens: string[]; // the designer's PNG per artboard, in artboards.json order
  sampleState: Record<string, unknown>;
}

const COMMAND = '{command}';
/** What the sample holds where an activity's worktree goes: it is a folder only on the evaluation's machine. */
export const WORKTREE_MARK = '{worktree}';
const SCENARIO_HEADING = /^## (S\d+) · (.+)$/;
const ARTBOARD_ID = /^4[a-z]\d?$/;
const ARTBOARD_FILE = /^[\w-]+\.png$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((x) => typeof x === 'string');

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`seed: "${field}" must be a non-empty string`);
  return value;
}

/** A delivery's section of the handoff, `## N · title`: from its heading to the line before the next `## ` or `---`, as the designer wrote it. */
export function deliverySection(handoff: string, delivery: number): string {
  const lines = handoff.split('\n');
  const heading = `## ${delivery} · `;
  const found = lines.flatMap((line, i) => (line.startsWith(heading) ? [i] : []));
  if (found.length !== 1) throw new Error(`seed: the handoff has ${found.length === 0 ? 'no section' : 'more than one section'} "${heading.trim()}"`);
  const rest = lines.slice(found[0] + 1);
  const end = rest.findIndex((line) => line.startsWith('## ') || line === '---');
  return [lines[found[0]], ...(end === -1 ? rest : rest.slice(0, end))].join('\n').trim();
}

// A blocker must come earlier in the file: the graph is acyclic by construction
function seedTask(raw: unknown, field: string, earlier: readonly SeedTask[], preamble: string, handoff: string): SeedTask {
  if (!isRecord(raw)) throw new Error(`seed: "${field}" must be an object`);
  const key = requireText(raw.key, `${field}.key`);
  if (earlier.some((t) => t.key === key)) throw new Error(`seed: "${field}.key" ${key} is already taken`);
  const blockedBy = raw.blockedBy;
  if (!isStringList(blockedBy)) throw new Error(`seed: "${field}.blockedBy" must be an array of keys`);
  const late = blockedBy.find((b) => !earlier.some((t) => t.key === b));
  if (late !== undefined) throw new Error(`seed: "${field}.blockedBy" names ${late}, which is not an earlier task`);
  const delivery = raw.delivery;
  if (typeof delivery !== 'number' || !Number.isInteger(delivery) || delivery < 1) throw new Error(`seed: "${field}.delivery" must be a section number`);
  return { key, title: requireText(raw.title, `${field}.title`), delivery, blockedBy, body: `${preamble}\n\n${deliverySection(handoff, delivery)}` };
}

/** tasks.json: one task per delivery; each body is the preamble plus that delivery's section, read from the handoff so the two never drift. */
export function parseTasks(raw: unknown, handoff: string): SeedTask[] {
  if (!isRecord(raw) || !Array.isArray(raw.tasks)) throw new Error('seed: tasks.json must be { preamble, tasks: [...] }');
  const preamble = requireText(raw.preamble, 'preamble');
  const entries: unknown[] = raw.tasks;
  const tasks: SeedTask[] = [];
  for (const [i, entry] of entries.entries()) tasks.push(seedTask(entry, `tasks[${i}]`, tasks, preamble, handoff));
  return tasks;
}

function seedStage(raw: unknown, field: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error(`seed: "${field}" must be an object`);
  const { role, prompt } = raw;
  if (role !== undefined && !STAGE_ROLES.includes(role as StageRole)) throw new Error(`seed: "${field}.role" must be one of: ${STAGE_ROLES.join(', ')}`);
  const hasCommand = typeof prompt === 'string' && prompt.includes(COMMAND);
  if (role !== undefined && !hasCommand) throw new Error(`seed: "${field}.prompt" must call {command}`);
  if (role === undefined && hasCommand) throw new Error(`seed: "${field}" uses {command} with no role`);
  return raw;
}

export function parseStagesSeed(raw: unknown): StagesSeed {
  const claudeArgs = isRecord(raw) ? raw.claudeArgs : undefined;
  const stages = isRecord(raw) ? raw.stages : undefined;
  if (!isStringList(claudeArgs) || !Array.isArray(stages)) throw new Error('seed: stages.json must be { claudeArgs: string[], stages: [...] }');
  const entries: unknown[] = stages;
  const parsed = entries.map((stage, i) => seedStage(stage, `stages[${i}]`));
  for (const role of STAGE_ROLES) {
    if (parsed.filter((s) => s.role === role).length !== 1) throw new Error(`seed: exactly one stage must have the role ${role}`);
  }
  return { claudeArgs, stages: parsed };
}

export function parseScenarios(markdown: string): Scenario[] {
  const lines = markdown.split('\n');
  const starts = lines.flatMap((line, i) => (SCENARIO_HEADING.test(line) ? [i] : []));
  if (starts.length === 0) throw new Error('seed: scenarios.md has no "## S<n> · <title>" scenario');
  return starts.map((start, k) => {
    const [, id, title] = SCENARIO_HEADING.exec(lines[start]) as RegExpExecArray;
    return { id, title, text: lines.slice(start + 1, starts[k + 1]).join('\n').trim() };
  });
}

function artboard(raw: unknown, field: string, earlier: readonly Artboard[]): Artboard {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ARTBOARD_ID.test(raw.id)) throw new Error(`seed: "${field}.id" must be an artboard id like 4a or 4c2`);
  if (earlier.some((a) => a.id === raw.id)) throw new Error(`seed: artboard ${raw.id} is listed twice`);
  if (typeof raw.file !== 'string' || !ARTBOARD_FILE.test(raw.file)) throw new Error(`seed: "${field}.file" must be a PNG name like 4a-padrao.png`);
  if (!Number.isInteger(raw.delivery) || (raw.delivery as number) < 1) throw new Error(`seed: "${field}.delivery" must be a delivery number`);
  if (typeof raw.live !== 'boolean') throw new Error(`seed: "${field}.live" must be true or false`);
  return { id: raw.id, file: raw.file, title: requireText(raw.title, `${field}.title`), delivery: raw.delivery as number, live: raw.live };
}

/** artboards.json: the designer's screens; `live` marks one only a running agent can show. */
export function parseArtboards(raw: unknown): Artboard[] {
  if (!Array.isArray(raw)) throw new Error('seed: artboards.json must be an array');
  const entries: unknown[] = raw;
  const list: Artboard[] = [];
  for (const [i, entry] of entries.entries()) list.push(artboard(entry, `artboards[${i}]`, list));
  return list;
}

export const screenPath = (dir: string, file: string): string => join(dir, 'handoff', 'png', file);

// Words aimed at a worker that would tell it this is a test (#105, the user); the phrases are ordinary. `hive test` is a command name the designer's README shows in the UI ("vitest · de hive test"), and the handoff stays verbatim
const WORKER_ALLOWED = ['pnpm test', 'run-commands.ts', 'hive test'];
const WORKER_FORBIDDEN = /\b(?:experiments?|arms?|runs?|benchmarks?|tests?)\b/gi;

export function forbiddenWords(text: string): string[] {
  const cleared = WORKER_ALLOWED.reduce((acc, phrase) => acc.replaceAll(phrase, ''), text);
  return [...new Set((cleared.match(WORKER_FORBIDDEN) ?? []).map((w) => w.toLowerCase()))];
}

/** Everything a worker reads: the handoff, each task title and body, each stage prompt. */
export function assertWorkerText(seed: Pick<Seed, 'handoff' | 'tasks' | 'stages'>): void {
  const texts: [string, string][] = [
    ['the handoff', seed.handoff],
    ...seed.tasks.map((t, i): [string, string] => [`tasks[${i}]`, `${t.title}\n${t.body}`]),
    ...seed.stages.stages.map((s, i): [string, string] => [`stages[${i}]`, typeof s.prompt === 'string' ? s.prompt : '']),
  ];
  for (const [where, text] of texts) {
    const words = forbiddenWords(text);
    if (words.length > 0) throw new Error(`seed: a worker would read "${words[0]}" in ${where}`);
  }
}

/** The handoff as the baseline carries it: the whole folder as laid out, so its own "Files" section stays true. */
export async function handoffFiles(dir: string = SEED_DIR): Promise<{ from: string; to: string }[]> {
  const root = join(dir, 'handoff');
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name !== '.DS_Store').map((e) => relative(root, join(e.parentPath, e.name))).sort();
  return files.map((file) => ({ from: join(root, file), to: `${HANDOFF_DIR}/${file.split(sep).join('/')}` }));
}

// The screens are the designer's, never generated: a missing one stops the experiment before anything runs
async function requireScreens(dir: string, artboards: readonly Artboard[]): Promise<string[]> {
  const paths = artboards.map((a) => screenPath(dir, a.file));
  const present = await Promise.all(paths.map((p) => access(p).then(() => true, () => false)));
  const missing = artboards.filter((_, i) => !present[i]).map((a) => a.file);
  if (missing.length > 0) throw new Error(`seed: missing handoff screens: ${missing.join(', ')} (expected under handoff/png/)`);
  return paths;
}

const readText = (dir: string, name: string): Promise<string> => readFile(join(dir, name), 'utf8');

export async function loadSeed(dir: string = SEED_DIR): Promise<Seed> {
  const handoff = await readText(dir, join('handoff', 'README.md'));
  const artboards = parseArtboards(JSON.parse(await readText(dir, 'artboards.json')));
  const screens = await requireScreens(dir, artboards);
  const sample: unknown = JSON.parse(await readText(dir, 'sample-state.json'));
  if (!isRecord(sample)) throw new Error('seed: sample-state.json must be an object');
  const seed: Seed = {
    handoff, artboards, screens, sampleState: sample,
    tasks: parseTasks(JSON.parse(await readText(dir, 'tasks.json')), handoff),
    stages: parseStagesSeed(JSON.parse(await readText(dir, 'stages.json'))),
    scenarios: parseScenarios(await readText(dir, 'scenarios.md')),
  };
  assertWorkerText(seed);
  return seed;
}

/** Every seed file by relative path and content, the handoff included: any change makes a new experiment. */
export async function seedHash(dir: string = SEED_DIR): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && e.name !== '.DS_Store').map((e) => join(e.parentPath, e.name)).sort();
  const hash = createHash('sha256');
  for (const path of files) hash.update(`${relative(dir, path)}\0`).update(await readFile(path)).update('\0');
  return hash.digest('hex');
}

/** The sample for one evaluation (#629: the work sits on the activities): each activity gets its task's slug, and {worktree} becomes a folder the evaluation creates under its checkout. */
export function materializeSample(raw: Record<string, unknown>, workspace: string): { state: Record<string, unknown>; worktrees: string[] } {
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).filter(isRecord);
  const records = (Array.isArray(raw.activityRecords) ? raw.activityRecords : []).filter(isRecord);
  const slugOfActivity = (id: unknown): string | undefined => {
    const itemId = (records.find((r) => r.id === id)?.taskIds as unknown[] | undefined)?.[0];
    const task = tasks.find((t) => isRecord(t.item) && t.item.itemId === itemId);
    return task ? slugFor(task.item as Item) : undefined;
  };
  const filled = (Array.isArray(raw.activities) ? raw.activities : []).filter(isRecord).map((activity): Record<string, unknown> => {
    const slug = slugOfActivity(activity.id);
    if (slug === undefined) return activity;
    return activity.worktree === WORKTREE_MARK ? { ...activity, slug, worktree: join(workspace, '.hive', 'worktrees', slug) } : { ...activity, slug };
  });
  return { state: { ...raw, activities: filled }, worktrees: filled.flatMap((a) => (typeof a.worktree === 'string' ? [a.worktree] : [])) };
}
