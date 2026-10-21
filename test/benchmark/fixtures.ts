import { initialState } from '../../src/orchestrator.js';
import type { Arm, ArmSetup, BenchIsolation, BenchStagePick, BenchRun, Experiment, State } from '../../src/types.js';

const pick = (skill: string): BenchStagePick => ({ agent: 'claude', skill, prompt: `${skill} {title}\n\n{body}` });
export const SETUP: ArmSetup = {
  stages: { spec: pick('/hive:new-spec'), plan: pick('/hive:new-plan'), build: pick('/hive:new-build'), pr: pick('/hive:new-pr') },
  plugins: [], rules: { allow: [], deny: [] }, tasks: [{ key: 'T1', title: 'One', body: 'b', blockedBy: [] }],
  items: {}, worktree: { setup: 'RUN pnpm install', teardown: '' },
};

export const ISOLATION: BenchIsolation = {
  environment: { all: 'local' }, network: { all: [] }, permissionMode: { all: 'dontAsk' }, allowedTools: { all: [] }, deniedTools: { all: [] },
  limits: { all: { turns: 200 } }, env: { all: { CI: '1' } }, betweenRounds: { all: 'fresh-worktree' },
};

export const arm = (id: string, letter: string, overrides: Partial<ArmSetup> = {}): Arm => ({ id, letter, name: `arm ${letter}`, overrides });

// The home under the fake Hive home /hive: the guard wants exactly <hiveDir>/benchmark/<id>/runs/<token>
export const run = (token: string, patch: Partial<BenchRun> = {}): BenchRun => ({
  token, armId: 'a1', round: 1, status: 'running', home: `/hive/benchmark/exp-1/runs/${token}`, branch: `neutral/${token}`,
  startedAt: '2026-10-21T10:00:00.000Z', sleptMs: 0, delivered: 0, total: 1, interventions: [], ...patch,
});

export const experiment = (patch: Partial<Experiment> = {}): Experiment => ({
  id: 'exp-1', name: 'Skills', status: 'draft', createdAt: '2026-10-21T09:00:00.000Z', createdBy: { kind: 'user' },
  workspace: 'hive', plugin: { version: '0.1.0', hash: 'p'.repeat(64) }, seedHash: 's'.repeat(64), tasksHash: 't'.repeat(64),
  base: SETUP, arms: [arm('a1', 'A'), arm('a2', 'B')],
  seed: { workspace: 'hive', commit: 'a'.repeat(40), reference: [], sample: { command: 'pnpm dev', url: '', files: [] }, scenarios: [] },
  pace: { pairs: 3, until: '07:00', runTimeoutMs: 72_000_000, workersPerArm: 3, cap: {} },
  isolation: ISOLATION, blindness: { on: true, forbiddenWords: ['benchmark'] },
  evaluation: { collectors: [], dynamic: true, judge: { agent: 'claude' }, rubric: '' },
  rounds: [], sleeps: [], ...patch,
});

export const stateWith = (...experiments: Experiment[]): State => ({ ...initialState(0), benchmark: { experiments } });

// A write into a frozen object throws in an ES module, so a reducer that mutates fails the test where it writes
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
