import type { LaunchPty, PtyHandle, PtyLaunch } from './types.js';

export interface StartPty {
  ptyId: string;
  launch: PtyLaunch;
  onExit(): void;
  onError(message: string): void; // a kill failure: the server puts it in the error bar
  onSpawnFailed(message: string): void; // `started` rejected: the entry is gone; the server frees the worker and marks the task
}

export interface PtyPool {
  start(o: StartPty): void;
  kill(ptyId: string): Promise<boolean>; // false when the pty is unknown; otherwise resolves with the handle's kill
  exit(ptyId: string): boolean; // an exit reported from outside (the curl trailer): same as the handle exiting
  /** Resolves once `ptyId`'s pty exists (the handle's own `started`); rejects with the spawner's message on a spawn failure, and
   * for a pty id this pool never started (#249): a route awaiting it answers ok either way, with no run to attach only on the rejection. */
  started(ptyId: string): Promise<void>;
  killAll(): Promise<void>;
  has(ptyId: string): boolean;
}

interface Entry {
  handle: PtyHandle;
  exit(): void;
}

/** In-memory registry of the live ptys, runs and terminals alike (#647), keyed by ptyId. Process state, not domain state: it is never persisted. */
export function createPtyPool(spawn: LaunchPty): PtyPool {
  const entries = new Map<string, Entry>();

  function start(o: StartPty): void {
    const { ptyId } = o;
    let exited = false;
    let own: Entry | undefined;
    // Only this start's entry leaves: a terminal's wake starts its id again, and the old pty's late exit or failure must not drop the new one (#696)
    const drop = (): void => {
      if (own !== undefined && entries.get(ptyId) === own) entries.delete(ptyId);
    };
    const onExit = (): void => {
      if (exited) return; // once: the handle and the external signal can both report it
      exited = true;
      drop();
      o.onExit();
    };
    const handle = spawn(o.launch, { onExit, onError: o.onError });
    if (!exited) { // a spawner may fail before returning
      own = { handle, exit: onExit };
      entries.set(ptyId, own);
    }
    handle.started.catch((err: Error) => { // the pty never existed: no exit will ever come for it
      drop();
      o.onSpawnFailed(err.message);
    });
  }

  return {
    start,
    kill: async (ptyId) => {
      const entry = entries.get(ptyId);
      if (!entry) return false;
      await entry.handle.kill(); // the entry itself only leaves on the exit
      return true;
    },
    exit: (ptyId) => {
      const entry = entries.get(ptyId);
      if (!entry) return false;
      entry.exit();
      return true;
    },
    started: async (ptyId) => {
      const entry = entries.get(ptyId);
      if (!entry) throw new Error(`unknown pty ${ptyId}`);
      await entry.handle.started;
    },
    killAll: async () => {
      await Promise.all([...entries.values()].map(({ handle }) => handle.kill()));
    },
    has: (ptyId) => entries.has(ptyId),
  };
}
