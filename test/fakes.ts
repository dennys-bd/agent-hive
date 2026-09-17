import { setTimeout as sleep } from 'node:timers/promises';
import type { Board, Config, SpawnWorker, WorkerHandlers } from '../src/types.js';

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

export const OPTIONS = ['Ready', 'In progress', 'In review', 'Done'];

// A board that has the OPTIONS columns and returns one task named after the configured queue column.
// `resolveDelayMs` makes resolveFields slow so concurrent saves overlap.
export function fakeBoardFactory(resolveDelayMs = 0): { factory: (config: Config) => Board; configs: Config[] } {
  const configs: Config[] = [];
  const factory = (config: Config): Board => {
    configs.push(config);
    return {
      async resolveFields() {
        if (resolveDelayMs > 0) await sleep(resolveDelayMs);
        for (const key of ['queue', 'working', 'review'] as const) {
          const wanted = config.status[key];
          if (!OPTIONS.includes(wanted)) {
            throw new Error(`status.${key} "${wanted}" not found in board Status options: ${OPTIONS.join(', ')}`);
          }
        }
      },
      async listQueue() {
        return [{ itemId: 'I1', id: '1', title: `from ${config.status.queue}`, body: '', url: 'https://github.com/acme/r/issues/1' }];
      },
      async setStatus() {},
      async setupOptions() {
        return OPTIONS;
      },
    };
  };
  return { factory, configs };
}
