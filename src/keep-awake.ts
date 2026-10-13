// Keep awake (#226): the daemon, not the viewer, holds the power assertion, as a child process that lives while State.keepAwake is set. It
// works headless and with the window closed, and the command ends with the daemon's pid, so a crash leaves nothing behind.
import { spawn as spawnChild } from 'node:child_process';
import { keepAwakeCommand } from './platform-commands.js';

/** What the holder needs of a child: the real ChildProcess, or a test's fake. */
export interface KeepAwakeChild {
  kill(): boolean;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type KeepAwakeSpawn = (file: string, args: readonly string[]) => KeepAwakeChild;

export interface KeepAwakeDeps {
  spawn: KeepAwakeSpawn;
  pid: number;
  platform: NodeJS.Platform;
  onFailure(err: Error): void;
}

export interface KeepAwake {
  sync(on: boolean): void;
  stop(): void;
}

/** The real spawn: an argv array, no shell, nothing read or written. */
export const spawnKeepAwake: KeepAwakeSpawn = (file, args) => spawnChild(file, [...args], { stdio: 'ignore' });

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** At most one child. A child is forgotten before it is killed or reported, so the exit a kill causes is no failure and a second event of
 *  the same child reports nothing. Its listeners stay: a ChildProcess emitting 'error' with none would throw in the daemon. */
export function createKeepAwake({ spawn, pid, platform, onFailure }: KeepAwakeDeps): KeepAwake {
  let held: KeepAwakeChild | undefined;
  const failed = (child: KeepAwakeChild, err: Error): void => {
    if (held !== child) return;
    held = undefined;
    onFailure(err);
  };
  function start(): void {
    try {
      const [file, args] = keepAwakeCommand(platform, pid);
      const child = spawn(file, args);
      held = child;
      child.on('error', (err) => failed(child, err));
      child.on('exit', (code, signal) => failed(child, new Error(`${file} exited (${signal ?? code})`)));
    } catch (err) {
      // sync runs inside the server's dispatch, and onFailure dispatches: deferred, it never re-enters it
      queueMicrotask(() => onFailure(asError(err)));
    }
  }
  function stop(): void {
    const child = held;
    held = undefined;
    child?.kill();
  }
  return {
    sync(on) {
      if (!on) stop();
      else if (held === undefined) start();
    },
    stop,
  };
}
