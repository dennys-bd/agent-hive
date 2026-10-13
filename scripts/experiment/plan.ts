import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { isPlainRef } from './git.js';
import { ARMS, type Arm, type Attempt, type Manifest, type Outcome, type RunRef } from './types.js';

const TOKEN = /^[0-9a-f]{6}$/;
const TOKEN_BYTES = 3;
const TOKEN_TRIES = 100;
const EXPERIMENT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const runRef = (arm: Arm, n: number): RunRef => ({ arm, n, id: `${arm}${n}` });
export const runOrder = (pairs: number): RunRef[] => Array.from({ length: pairs }, (_, i) => ARMS.map((arm) => runRef(arm, i + 1))).flat();

/** Everything a worker sees is named by the token, as ordinary feature work (#105, the user). */
export const runBranch = (token: string): string => `feat/monitor-view-${token}`;
/** Outside the repo: a worker reaches its worktree through ./**, never the homes (they hold each daemon's secret). Computed from the environment, never hardcoded. */
export const stateRoot = (env: NodeJS.ProcessEnv, home: string): string =>
  join(env.XDG_STATE_HOME !== undefined && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state'), 'agent-hive-lab');
export const runHome = (state: string, token: string): string => join(state, 'homes', token);
export const experimentDir = (state: string, id: string): string => join(state, 'experiments', id);
/** The run's Comb prefix: replaces the spec's MON for runs, so the two arms of a pair never share a task id, branch or worktree. */
export const runPrefix = (token: string): string => `M${token.toUpperCase()}`;

export function newToken(taken: ReadonlySet<string>, draw: () => string = () => randomBytes(TOKEN_BYTES).toString('hex')): string {
  for (let i = 0; i < TOKEN_TRIES; i += 1) {
    const token = draw();
    if (TOKEN.test(token) && !taken.has(token)) return token;
  }
  throw new Error('could not draw a free run token');
}

const pad = (n: number): string => String(n).padStart(2, '0');
const stamp = (at: Date): string => `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
export const newExperimentId = (now: Date): string => `skills-${stamp(now)}`;

export function requireExperimentId(id: string): string {
  if (!EXPERIMENT_ID.test(id)) throw new Error(`--experiment must be lowercase letters, digits and -, up to 48: ${id}`);
  return id;
}

export interface NewManifest { id: string; source: string; baseline: string; docsSource: string; docsBaseline: string; seedHash: string; runs: number; now: Date }
export const newManifest = ({ id, source, baseline, docsSource, docsBaseline, seedHash, runs, now }: NewManifest): Manifest =>
  ({ id, source, baseline, docsSource, docsBaseline, seedHash, runs, createdAt: now.toISOString(), attempts: [] });

const ofSlot = (ref: RunRef) => (a: Attempt): boolean => a.arm === ref.arm && a.n === ref.n;
export const latest = (m: Manifest, ref: RunRef): Attempt | undefined => m.attempts.filter(ofSlot(ref)).at(-1);
export function isMeasured(m: Manifest, ref: RunRef): boolean {
  const outcome = latest(m, ref)?.outcome;
  return outcome !== undefined && outcome !== 'interrupted';
}
export const openAttempts = (m: Manifest): Attempt[] => m.attempts.filter((a) => a.outcome === undefined);

export const startAttempt = (m: Manifest, ref: RunRef, token: string, at: Date, unpaired: boolean): Manifest => ({
  ...m, attempts: [...m.attempts, { token, arm: ref.arm, n: ref.n, startedAt: at.toISOString(), ...(unpaired ? { unpaired: true as const } : {}) }],
});
export const endAttempt = (m: Manifest, token: string, outcome: Outcome): Manifest =>
  ({ ...m, attempts: m.attempts.map((a) => (a.token === token ? { ...a, outcome } : a)) });

/** A new call: a changed seed is refused; an attempt still open was cut by the last call's end and is marked interrupted (#105, the user). */
/** A re-judge's note when the seed moved since the runs: their branches are what they are, so they are judged against today's
 *  scenarios, handoff and sample instead of being refused, as resuming a night would be (resumeManifest). */
export function seedDrift(m: Manifest, seedHash: string): string | undefined {
  if (m.seedHash === seedHash) return undefined;
  return `experiment ${m.id}: the seed changed since its runs (${m.seedHash.slice(0, 8)} → ${seedHash.slice(0, 8)}); judging them against the current scenarios, handoff and sample`;
}

export function resumeManifest(m: Manifest, seedHash: string, runs: number | undefined): Manifest {
  if (m.seedHash !== seedHash) {
    throw new Error(`experiment ${m.id}: the seed changed since it was created (${m.seedHash.slice(0, 8)} → ${seedHash.slice(0, 8)}); start a new experiment`);
  }
  const attempts = m.attempts.map((a) => (a.outcome === undefined ? { ...a, outcome: 'interrupted' as const } : a));
  return { ...m, ...(runs === undefined ? {} : { runs }), attempts };
}

const isAttempt = (a: unknown): boolean => {
  const x = a as Partial<Attempt> | null;
  return typeof x?.token === 'string' && TOKEN.test(x.token) && // a token names a folder and a branch: no path may ride in it
    (x.arm === 'a' || x.arm === 'b') && Number.isInteger(x.n) && typeof x.startedAt === 'string';
};

export function parseManifest(raw: unknown): Manifest {
  const m = raw as Partial<Manifest> | null;
  // id names a folder, the shas reach git's argv: each keeps the shape the harness wrote
  const refs = [m?.source, m?.baseline, m?.docsSource, m?.docsBaseline];
  const ok = typeof m?.id === 'string' && EXPERIMENT_ID.test(m.id) && refs.every((r) => typeof r === 'string' && isPlainRef(r)) && typeof m.seedHash === 'string'
    && Number.isInteger(m.runs) && typeof m.createdAt === 'string' && Array.isArray(m.attempts) && m.attempts.every(isAttempt);
  if (!ok) throw new Error('manifest.json is not an experiment manifest');
  return m as Manifest;
}
