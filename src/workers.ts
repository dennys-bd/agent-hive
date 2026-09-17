import type { SpawnWorker, WorkerHandle, WorkerLaunch } from './types.js';

export interface StartWorker {
  workerId: string;
  launch: WorkerLaunch;
  onExit(): void;
  onError(message: string): void; // a spawner failure: the server puts it in the error bar
}

export interface WorkerPool {
  start(o: StartWorker): void;
  kill(workerId: string): boolean; // false when the worker is unknown
  exit(workerId: string): boolean; // an exit reported from outside (the curl trailer): same as the handle exiting
  focus(workerId: string): Promise<boolean>; // false when unknown; rejects when the terminal cannot open
  killAll(): void;
  has(workerId: string): boolean;
}

interface Entry {
  handle: WorkerHandle;
  exit(): void;
}

/** In-memory registry of live workers keyed by workerId. Process state, not domain state: it is never persisted. */
export function createWorkerPool(spawn: SpawnWorker): WorkerPool {
  const entries = new Map<string, Entry>();

  function start(o: StartWorker): void {
    const { workerId } = o;
    let exited = false;
    const onExit = (): void => {
      if (exited) return; // once: the handle and the external signal can both report it
      exited = true;
      entries.delete(workerId);
      o.onExit();
    };
    const handle = spawn(o.launch, { onExit, onError: o.onError });
    if (!exited) entries.set(workerId, { handle, exit: onExit }); // a spawner may fail before returning
  }

  function call(workerId: string, action: (entry: Entry) => void): boolean {
    const entry = entries.get(workerId);
    if (!entry) return false;
    action(entry);
    return true;
  }

  return {
    start,
    kill: (workerId) => call(workerId, (entry) => entry.handle.kill()),
    exit: (workerId) => call(workerId, (entry) => entry.exit()),
    focus: async (workerId) => {
      const entry = entries.get(workerId);
      if (!entry) return false;
      await entry.handle.focus();
      return true;
    },
    killAll: () => {
      for (const { handle } of entries.values()) handle.kill();
    },
    has: (workerId) => entries.has(workerId),
  };
}
