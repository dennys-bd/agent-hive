import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '../src/log.js';
import type { Board, BoardQuota, Config, SpawnWorker, WorkerHandlers, WorkerLaunch } from '../src/types.js';

export interface FakeWorker {
  launch: WorkerLaunch;
  handlers: WorkerHandlers;
  killed: number;
  focused: number;
  focusError?: Error; // set by a test: the next focus() rejects, like a terminal that cannot open
}

/** A SpawnWorker that opens nothing: records every call and exposes the handlers so a test can report errors and exits. */
export function fakeSpawn(): { spawn: SpawnWorker; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const spawn: SpawnWorker = (launch, handlers) => {
    const worker: FakeWorker = { launch, handlers, killed: 0, focused: 0 };
    workers.push(worker);
    return {
      kill: () => {
        worker.killed += 1;
      },
      focus: async () => {
        worker.focused += 1;
        if (worker.focusError) throw worker.focusError;
      },
    };
  };
  return { spawn, workers };
}

export const LAUNCH: WorkerLaunch = {
  mode: 'embedded', workerId: 'W1', slug: 'hive-1-task', repo: '/repo', port: 4242,
  hooksPath: '/repo/.hive/hooks.json', promptPath: '/repo/.hive/prompts/hive-1-task.md', claudeArgs: [],
};

export const OPTIONS = ['Ready', 'In progress', 'In review', 'Done'];

// A board that has the OPTIONS columns and returns one task named after the configured queue column.
// `resolveDelayMs` makes resolveFields slow so concurrent saves overlap; `quota` gives it a fixed quota reading (none by default, like markdown).
export function fakeBoardFactory(resolveDelayMs = 0, quota?: BoardQuota): { factory: (config: Config) => Board; configs: Config[] } {
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
      ...(quota ? { quota: async () => quota } : {}),
    };
  };
  return { factory, configs };
}

/** A Logger that writes nothing: every call becomes a `LEVEL message` line, whatever the level, and setLevel a `LEVEL <level>` line. */
export function fakeLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const at = (tag: string) => (message: string): void => {
    lines.push(`${tag} ${message}`);
  };
  return { lines, log: { error: at('ERROR'), info: at('INFO'), debug: at('DEBUG'), setLevel: at('LEVEL') } };
}
