// Shared shapes of the skills A/B experiment (#105). Written under <state>/experiments/<id>/ (plan.ts stateRoot); the Hive never reads them.

export type Arm = 'a' | 'b';
export const ARMS: readonly Arm[] = ['a', 'b'];

/** A slot: run n of one arm (a1, b1…). Slots n of both arms form pair n. Only the manifest and the report know it. */
export interface RunRef { arm: Arm; n: number; id: string }
export type Outcome = 'done' | 'timeout' | 'error';
/** One attempt at a slot. Branch, home, task prefix and folder are named by its token alone, so nothing a worker or a reviewer sees names the arm. */
export interface Attempt { token: string; arm: Arm; n: number; startedAt: string; outcome?: Outcome | 'interrupted'; unpaired?: true }

export interface Manifest {
  id: string;
  source: string; // the sha of the ref the experiment was made from, for the record
  baseline: string; // the orphan commit every run starts from: the source's tree without the experiment
  docsSource: string; // the sha of the docs clone's origin/main, for the record (#79)
  docsBaseline: string; // in the docs clone: its tree without any doc that names the experiment, with the handoff
  seedHash: string;
  runs: number; // pairs
  createdAt: string;
  attempts: Attempt[];
}

export interface StageSpan { stage: string; ms: number }
export interface TaskMetrics { itemId: string; id: string; tokens: number; ms: number; waitingMs: number; stages: StageSpan[]; buildRestarts: number }
export interface DiffSize { files: number; insertions: number; deletions: number }

export interface Metrics {
  token: string; outcome: Outcome; reason?: string; startedAt: string; endedAt: string;
  tasks: TaskMetrics[]; tokens: number; ms: number; waitingMs: number; buildRestarts: number; diff: DiffSize;
  reportedTestsGreen?: boolean;
  unpaired?: true;
}

export interface EvalResult { booted: boolean; testsGreen: boolean; reason?: string }
export interface Click { scenario: string; passed: boolean; notes: string; screenshots: string[] }
export const CRITERIA = ['fidelity', 'behaviour', 'code', 'specAndPlan', 'tests'] as const;
export type Criterion = (typeof CRITERIA)[number];
export interface Score { score: number | null; reason: string }
export interface Judge { model: string; scores: Record<Criterion, Score> }

export const FILES = {
  manifest: 'manifest.json', metrics: 'metrics.json', evaluation: 'eval.json', clicks: 'clicks.json', judge: 'judge.json',
  report: 'report.md', screens: 'screens', bundle: 'bundle',
} as const;
