import type { SpawnWorker, WorkerHandle, WorkerLaunch } from './types.js';

export interface StartWorker {
  workerId: string;
  launch: WorkerLaunch;
  onExit(): void;
  onError(message: string): void; // a kill / focus failure: the server puts it in the error bar
  onSpawnFailed(message: string): void; // `started` rejected: the entry is gone; the server frees the slot and marks the card
}

export interface WorkerPool {
  start(o: StartWorker): void;
  kill(workerId: string): Promise<boolean>; // false when the worker is unknown; otherwise resolves with the handle's kill
  exit(workerId: string): boolean; // an exit reported from outside (the curl trailer): same as the handle exiting
  focus(workerId: string): Promise<boolean>; // false when unknown; rejects when the terminal cannot open
  killAll(): Promise<void>;
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
    handle.started.catch((err: Error) => { // the session never existed: no exit will ever come for it
      entries.delete(workerId);
      o.onSpawnFailed(err.message);
    });
  }

  return {
    start,
    kill: async (workerId) => {
      const entry = entries.get(workerId);
      if (!entry) return false;
      await entry.handle.kill(); // the entry itself only leaves on the exit
      return true;
    },
    exit: (workerId) => {
      const entry = entries.get(workerId);
      if (!entry) return false;
      entry.exit();
      return true;
    },
    focus: async (workerId) => {
      const entry = entries.get(workerId);
      if (!entry) return false;
      await entry.handle.focus();
      return true;
    },
    killAll: async () => {
      await Promise.all([...entries.values()].map(({ handle }) => handle.kill()));
    },
    has: (workerId) => entries.has(workerId),
  };
}
