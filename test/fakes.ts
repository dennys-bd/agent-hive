import type { SpawnWorker, WorkerHandlers } from '../src/types.js';

export interface FakeWorker {
  argv: string[];
  opts: { cwd: string; env: NodeJS.ProcessEnv };
  handlers: WorkerHandlers;
  sent: string[];
  ended: number;
  killed: number;
}

/** A SpawnWorker that opens nothing: records every call and exposes the handlers so a test can emit lines and exits. */
export function fakeSpawn(): { spawn: SpawnWorker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const spawn: SpawnWorker = (argv, opts, handlers) => {
    const worker: FakeWorker = { argv, opts, handlers, sent: [], ended: 0, killed: 0 };
    workers.push(worker);
    return {
      send: (text) => {
        worker.sent.push(text);
      },
      end: () => {
        worker.ended += 1;
      },
      kill: () => {
        worker.killed += 1;
      },
    };
  };
  return { spawn, workers };
}
