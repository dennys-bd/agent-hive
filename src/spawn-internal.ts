import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { claudeEnvLine, commandShimsEnvFile } from './command-shim.js';
import { posixShell, posixShellEnv } from './posix-shell.js';
import { runTmpDir, ptyCommand, ptyEnv, shimsFirst } from './spawn.js';
import type { SpawnOptions, PtyHandle, PtyHandlers, PtyLaunch } from './types.js';

const TMP_MODE = 0o700; // the run's temp files are this user's only (#428)
const ENV_FILE_MODE = 0o600;
const ENV_DIR_MODE = 0o700; // the folder of every run's command-shims.sh, this user's only (#800)
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

// #800: the run's command-shims.sh goes with it as its TMPDIR does, a failure on the error bar
function removeEnvFile(file: string, onError: PtyHandlers['onError']): void {
  rm(file, { force: true }).catch((err: unknown) => onError(`command shims env: ${errorMessage(err)}`));
}

// #800: the line Claude Code's Bash tool sources (CLAUDE_ENV_FILE, ptyEnv), one file per run, so what a SessionStart hook appends to it
// stays this run's. Written on every OS, where ptyEnv names it (#806). A leftover of a run with this id is dropped first, so the
// exclusive write makes the file anew with its own mode
function writeEnvFile(file: string, commandShims: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: ENV_DIR_MODE });
  chmodSync(dir, ENV_DIR_MODE); // mkdir's mode applies only to a folder it makes
  rmSync(file, { force: true });
  writeFileSync(file, claudeEnvLine(commandShims, process.platform), { mode: ENV_FILE_MODE, flag: 'wx' });
}

// The run in the host through `sh -c ptyCommand`, with `tmp` as its TMPDIR (and TEMP / TMP on win32, #644). A failure is `started` rejecting: the pool reports it as
// spawnFailed, and there is no exit to report. A dir that cannot be made fails the run too, since on the shared temp dir it would leak
// again (#428); a pty that cannot spawn drops the dir made for it. Two tries, so a dir never made is never removed.
function startIn(options: SpawnOptions | undefined, launch: PtyLaunch, tmp: string, onExit: () => void, dropTmp: () => void): Promise<void> {
  if (!options) return Promise.reject(new Error('pty: no pty host'));
  const { ptys, secretFile, commandShims } = options;
  try {
    mkdirSync(tmp, { recursive: true, mode: TMP_MODE });
  } catch (err) {
    return spawnFailed(err);
  }
  try {
    writeEnvFile(commandShimsEnvFile(commandShims, launch.ptyId, path), commandShims);
    // the secret's file path rides the env, never the value: sh -c's argv and curl's are visible to every account through ps (#467). An
    // agent's run keeps its transcript past its exit for its sleeping tab (#672); a kept terminal's goes to its log (#696), a command's with it
    // #631: on win32 MSYS must not rewrite the trailer's /hooks/exit; a terminal's own env still wins (#696)
    const merged = { ...ptyEnv(process.env, launch.ptyId, launch.port, tmp, secretFile, process.platform, commandShims), ...posixShellEnv(process.platform), ...launch.env };
    const env = shimsFirst(merged, commandShims, process.platform); // a workspace's own PATH (#738) came in with launch.env
    ptys.spawn(launch.ptyId, [posixShell().shell, '-c', ptyCommand(launch)], launch.cwd, env, launch.terminal === undefined ? {} : launch.keep, launch.size); // #808: the page's grid
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
  const envFile = options === undefined ? undefined : commandShimsEnvFile(options.commandShims, launch.ptyId, path);
  const dropTmp = (): void => {
    removeTmp(tmp, handlers.onError);
    if (envFile !== undefined) removeEnvFile(envFile, handlers.onError);
  };
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
