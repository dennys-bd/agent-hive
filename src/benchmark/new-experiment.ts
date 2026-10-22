// What a new experiment starts from (#459): the base the workspace's current settings give (decomposition node 1), the screens' defaults,
// and the copies duplicate and fork make. Pure: ids, the clock, the commit, the hashes and the catalogue come from the route.
import { type AgentId, type ArmSetup, type BenchBlindness, type BenchEvaluation, type BenchIsolation, type BenchPace, type BenchSeed, type BenchStagePick, type BenchStageRole, type CatalogueItem, type Config, EXPERIMENT_ID, type Experiment, type Stage, type Workspace } from '../types.js';
import { armName } from './arms.js';
import { SANDBOX_DOMAINS } from './sandbox.js';
import { splitRules, WORKER_ALLOW, WORKER_DENY } from './worker-rules.js';

const HOUR_MS = 3_600_000;
const DEFAULT_TURNS = 200;
const ID_PREFIX = 'x';
const ID_TRIES = 16;
const PLUGIN_DIR_FLAG = '--plugin-dir';
const ALLOW_FLAG = '--allowedTools';
const DENY_FLAG = '--disallowedTools';
const FIRST_FORK = 2;

export const DEFAULT_PACE: BenchPace = { pairs: 3, until: '07:00', runTimeoutMs: 20 * HOUR_MS, workersPerArm: 3, cap: {} };
export const BLIND_WORDS: readonly string[] = ['benchmark', 'braço', 'arm', 'experimento', 'experiment'];

export const defaultIsolation = (): BenchIsolation => ({
  environment: { all: 'local' }, network: { all: [...SANDBOX_DOMAINS] }, permissionMode: { all: 'dontAsk' },
  allowedTools: { all: [...WORKER_ALLOW] }, deniedTools: { all: [...WORKER_DENY] }, limits: { all: { turns: DEFAULT_TURNS, ms: 2 * HOUR_MS } },
  env: { all: { CI: '1' } }, betweenRounds: { all: 'fresh-worktree' },
});
export const defaultBlindness = (): BenchBlindness => ({ on: true, forbiddenWords: [...BLIND_WORDS] });
export const defaultEvaluation = (judge: AgentId): BenchEvaluation => ({ collectors: [], dynamic: true, judge: { agent: judge }, rubric: '' });
export const emptySeed = (workspace: string, commit: string): BenchSeed => ({ workspace, commit, reference: [], sample: { command: '', url: '', files: [] }, scenarios: [] });

// The args after `flag` up to the next flag: Claude's tool lists are variadic
function flagRules(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => {
    if (arg !== flag) return [];
    const rest = args.slice(i + 1);
    const end = rest.findIndex((a) => a.startsWith('-'));
    return (end === -1 ? rest : rest.slice(0, end)).flatMap(splitRules);
  });
}

/** The call a stage makes for a role: a skill stage's `/hive:<skill>`, or the `/hive:new-<role>` / `/hive-<role>` its prompt holds. A
 *  following letter or dash is another skill (`/hive-pr-review`). */
export function stageCall(stage: Stage, role: BenchStageRole): string | undefined {
  if (stage.action === 'skill') return stage.skill === `new-${role}` || stage.skill === `hive-${role}` ? `/hive:${stage.skill}` : undefined;
  return stage.prompt?.match(new RegExp(`/hive(?::new-|-)${role}(?![\\w-])`))?.[0];
}

function pickFor(config: Pick<Config, 'comb' | 'defaultAgent'>, role: BenchStageRole): BenchStagePick {
  const stage = config.comb.stages.find((s) => stageCall(s, role) !== undefined);
  const call = stage === undefined ? undefined : stageCall(stage, role);
  if (stage === undefined || call === undefined) return { agent: config.defaultAgent, skill: `/hive:new-${role}`, prompt: `/hive:new-${role}` };
  const model = stage.model === undefined ? {} : { model: stage.model };
  return { agent: stage.agent ?? config.defaultAgent, ...model, skill: call, prompt: stage.prompt ?? call };
}

const itemsFor = (catalogue: readonly CatalogueItem[], workspace: string): Record<string, string> =>
  Object.fromEntries(catalogue.flatMap((item) => {
    const active = item.versions.find((v) => v.workspaces.includes(workspace));
    return active === undefined ? [] : [[item.id, active.name]];
  }));

/** The workspace's current settings as an experiment's base (decomposition node 1; the spec's decisions on #471's fields). */
export function baseSnapshot(config: Pick<Config, 'comb' | 'defaultAgent' | 'agentArgs'>, workspace: Pick<Workspace, 'name' | 'setup' | 'teardown'>, catalogue: readonly CatalogueItem[]): ArmSetup {
  const args = config.agentArgs.claude;
  return {
    stages: { spec: pickFor(config, 'spec'), plan: pickFor(config, 'plan'), build: pickFor(config, 'build'), pr: pickFor(config, 'pr') },
    plugins: args.flatMap((arg, i) => (arg === PLUGIN_DIR_FLAG && i + 1 < args.length ? [args[i + 1]] : [])),
    rules: { allow: flagRules(args, ALLOW_FLAG), deny: flagRules(args, DENY_FLAG) },
    tasks: [], items: itemsFor(catalogue, workspace.name), worktree: { setup: workspace.setup ?? '', teardown: workspace.teardown ?? '' },
  };
}

/** `x` + the draw (8 base36 characters from the route): folder-safe, unguessable, and never an id already held. */
export function newId(taken: readonly string[], draw: () => string): string {
  for (let i = 0; i < ID_TRIES; i += 1) {
    const id = `${ID_PREFIX}${draw()}`;
    if (EXPERIMENT_ID.test(id) && !taken.includes(id)) return id;
  }
  throw new Error('no free id');
}

export const defaultName = (experiments: readonly Experiment[], workspace: string): string => `Experiment ${experiments.filter((e) => e.workspace === workspace).length + 1}`;
export const copyName = (name: string): string => `${name} · copy`;
export function forkName(name: string, taken: readonly string[]): string {
  let n = FIRST_FORK;
  while (taken.includes(`${name} · ${n}`)) n += 1;
  return `${name} · ${n}`;
}

export interface NewExperiment { id: string; armId: string; name: string; createdAt: string; seed: BenchSeed; base: ArmSetup; judge: AgentId; plugin: Experiment['plugin']; seedHash: string; tasksHash: string }

export const emptyExperiment = (n: NewExperiment): Experiment => ({
  id: n.id, name: n.name, status: 'draft', createdAt: n.createdAt, createdBy: { kind: 'user' }, workspace: n.seed.workspace,
  plugin: n.plugin, seedHash: n.seedHash, tasksHash: n.tasksHash, base: n.base, arms: [{ id: n.armId, letter: 'A', name: armName('A'), overrides: {} }],
  seed: n.seed, pace: { ...DEFAULT_PACE, cap: {} }, isolation: defaultIsolation(), blindness: defaultBlindness(), evaluation: defaultEvaluation(n.judge), rounds: [], sleeps: [],
});

export interface CopyOf { id: string; name: string; createdAt: string }

/** Arms, tasks and every section kept, the hashes and the pin's hash kept; a new draft with no round of its own. */
export function duplicateOf(source: Experiment, copy: CopyOf): Experiment {
  const { archived: _archived, stopAfterRound: _stop, ...kept } = source;
  return { ...kept, id: copy.id, name: copy.name, createdAt: copy.createdAt, status: 'draft', createdBy: { kind: 'user' }, rounds: [], sleeps: [] };
}

export const forkOf = (source: Experiment, copy: CopyOf & { seed: BenchSeed; seedHash: string }): Experiment => ({ ...duplicateOf(source, copy), seed: copy.seed, seedHash: copy.seedHash });
