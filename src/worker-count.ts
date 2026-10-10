// What the caps count (#459, #475, #727): every worker, a stage run (automatic, started by hand, held for approval, backing off) and a commands
// stage's run; never a free session, a copy or a terminal. Pure and free of Node, so the reducer and the flowchart's nodes count alike.
import { taskOfWorker } from './activities.js';
import type { State, Worker } from './types.js';

type Counted = Pick<State, 'workers' | 'tasks' | 'activities' | 'activityRecords'>;

/** The workers the global cap counts. */
export const workerCount = (workers: Worker[]): number => workers.filter((s) => s.status !== 'empty' && !s.freeSession).length;

// The stage a worker's run counts against: its task's, or the commands stage whose run holds it (#727: that worker has no activity)
const stageOfWorker = (state: Counted, worker: Worker): string | undefined =>
  taskOfWorker(state, worker)?.stage ?? state.activities.find((a) => a.commands?.workerId === worker.id)?.commands?.stage;

/** The workers a stage's cap counts: the same ones, those whose run is in `stage`. */
export const stageWorkerCount = (state: Counted, stage: string): number =>
  state.workers.filter((s) => s.status !== 'empty' && !s.freeSession && stageOfWorker(state, s) === stage).length;
