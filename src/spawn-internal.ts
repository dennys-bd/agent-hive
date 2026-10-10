import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { runTmpDir, ptyCommand, ptyEnv } from './spawn.js';
import type { SpawnOptions, PtyHandle, PtyHandlers, PtyLaunch } from './types.js';

const SHELL = '/bin/sh';
const TMP_MODE = 0o700; // the run's temp files are this user's only (#428)
// A process of the run can outlive the pty and keep writing its TMPDIR (node's compile cache), so the removal retries ENOTEMPTY with a
// linear backoff, about 5 s in all (#495).
const TMP_RM_RETRIES = 10;
const TMP_RM_RETRY_MS = 100;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const spawnFailed = (err: unknown): Promise<void> => Promise.reject(new Error(`pty: ${errorMessage(err)}`));

// The run's own TMPDIR goes with the run (#428). Started and never awaited, so the exit is reported at once; a failure reaches the error bar.
function removeTmp(dir: string, onError: PtyHandlers['onError']): void {
  rm(dir, { recursive: true, force: true, maxRetries: TMP_RM_RETRIES, retryDelay: TMP_RM_RETRY_MS }).catch((err: unknown) => onError(`tmp: ${errorMessage(err)}`));
}

// The run in the host through `sh -c ptyCommand`, with `tmp` as its TMPDIR. A failure is `started` rejecting: the pool reports it as
// spawnFailed, and there is no exit to report. A dir that cannot be made fails the run too, since on the shared temp dir it would leak
// again (#428); a pty that cannot spawn drops the dir made for it. Two tries, so a dir never made is never removed.
function startIn(options: SpawnOptions | undefined, launch: PtyLaunch, tmp: string, onExit: () => void, dropTmp: () => void): Promise<void> {
  if (!options) return Promise.reject(new Error('pty: no pty host'));
  const { ptys, secretFile } = options;
  try {
    mkdirSync(tmp, { recursive: true, mode: TMP_MODE });
  } catch (err) {
    return spawnFailed(err);
  }
  try {
    // the secret's file path rides the env, never the value: sh -c's argv and curl's are visible to every account through ps (#467). An
    // agent's run keeps its transcript past its exit for its sleeping tab (#672); a kept terminal's goes to its log (#696), a command's with it
    const env = { ...ptyEnv(process.env, launch.ptyId, launch.port, tmp, secretFile), ...launch.env }; // a terminal's own wins (#696)
    ptys.spawn(launch.ptyId, [SHELL, '-c', ptyCommand(launch)], launch.cwd, env, launch.terminal === undefined ? {} : launch.keep, launch.size); // #808: the page's grid
  } catch (err) {
    dropTmp();
    return spawnFailed(err);
  }
  ptys.subscribe(launch.ptyId, () => {}, onExit);
  return Promise.resolve();
}

/**
 * A worker in a pty of the Hive's own (#251). The pty's exit is the run's exit, reported once. The command keeps its `curl /hooks/exit`
 * trailer, and the pool's exit-once guard absorbs the second report. The page reads the pty through the SSE route. The run's TMPDIR
 * (#428) lives from the spawn to that exit.
 */
export function launchInternalPty(launch: PtyLaunch, handlers: PtyHandlers, options?: SpawnOptions): PtyHandle {
  const tmp = runTmpDir(launch.ptyId);
  const dropTmp = (): void => removeTmp(tmp, handlers.onError);
  let exited = false;
  let killing: Promise<void> | undefined;
  let markGone: () => void = () => {};
  const gone = new Promise<void>((resolve) => { markGone = resolve; });
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    dropTmp();
    markGone();
    handlers.onExit();
  };
  const started = startIn(options, launch, tmp, exitOnce, dropTmp);
  // One kill per handle, resolved on the pty's exit; a run that never started has nothing to kill, and one already gone resolves at once.
  const kill = (): Promise<void> => {
    killing ??= started.then(() => {
      options?.ptys.kill(launch.ptyId);
      return gone;
    }, () => undefined);
    return killing;
  };
  return { started, kill };
}
