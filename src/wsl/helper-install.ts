// The distro's helper on its disk (#945): the bundle's hash, the probe that finds the distro's node and its Hive folder through the user's
// login shell, and the install that copies the bundle in over one wsl.exe's stdin, since nothing else can write there before the helper runs.
// Every line is fixed text: each variable part is a positional argument, and none has a backslash, which Git for Windows' sh.exe collapses.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type MachineChild, MachineError, type MachineExec } from '../machine.js';
import { type WslDeps, wslArgv, wslEnv } from './wsl-exe.js';

export const NODE_MISSING = 'node_missing';
export const NODE_OLD = 'node_old';
export const HELPER_FAILED = 'helper_failed';
export const DISTRO_MISSING = 'distro_missing';
const NODE_MIN_MAJOR = 24;
const HASH_CHARS = 16;
const OUTPUT_MAX = 4096; // what of a failed install's output its error keeps
const FOLDER_TAIL = '/.config/agent-hive/wsl';
// wsl.exe's own message (WSL_E_DISTRO_NOT_FOUND), or its English text, which the fake prints
const NO_DISTRO = /DISTRO_NOT_FOUND|no distribution/i;
const MAJOR = /^v?(\d+)\./;

/** The packaged bundle, dist/wsl-helper.mjs: this file runs from dist/src/wsl/. */
export const helperBundle = (): string => fileURLToPath(new URL('../../wsl-helper.mjs', import.meta.url));

/** node:child_process' spawn as the server hands it: stdin, stdout and stderr piped. */
export type SpawnChild = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; windowsHide: true }) => MachineChild;
export interface InstallDeps extends WslDeps { distro: string; spawn: SpawnChild }

export const helperHash = (bundle: Uint8Array): string => createHash('sha256').update(bundle).digest('hex').slice(0, HASH_CHARS);
export const helperPath = (folder: string, hash: string): string => `${folder}/helper-${hash}.mjs`;

/** The machine's refusal with a reason, as machines.ts' unavailableMachine words it. */
export const unavailable = (id: string, reason: string, cause?: unknown): MachineError =>
  new MachineError(`machine ${id} is unavailable: ${reason}`, { code: MachineError.UNAVAILABLE, reason }, cause === undefined ? undefined : { cause });

// $1 the line to run, the rest its arguments. The login shell is the passwd entry's, then $SHELL, then /bin/sh, so the line gets the user's
// own PATH (nvm, fnm, ~/.local/bin); one that is not a POSIX shell (fish, tcsh) cannot run the line, so /bin/sh logs in instead. The
// profile's stdout goes to stderr while it loads (fd 3 keeps the real one), so a ~/.profile that prints cannot break the probe's lines or
// the helper's frames; the inner line gives fd 1 back first
export const LOGIN_SHELL = 'shell=$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7); [ -n "$shell" ] || shell=$SHELL; case "$(basename "$shell")" in sh|bash|zsh|dash|ksh|ash) ;; *) shell=/bin/sh ;; esac; inner=$1; shift; exec 3>&1 1>&2; exec "$shell" -l -c "$inner" "$shell" "$@"';
// $1 node, $2 the hash, $3 PROBE_JS. A node not found prints nothing, which parseProbe reads as node_missing
export const PROBE_LINE = 'exec 1>&3 3>&-; command -v "$1" >/dev/null 2>&1 || exit 0; exec "$1" -e "$3" "$2"';
// The folder from node's own homedir, as the helper's info().homedir is: Git's sh.exe hands $HOME on as /c/..., which a native node cannot open
export const PROBE_JS = `const os = require('node:os'); const fs = require('node:fs'); const dir = os.homedir() + '${FOLDER_TAIL}'; console.log(process.versions.node); console.log(dir); console.log(fs.existsSync(dir + '/helper-' + process.argv[1] + '.mjs') ? 'yes' : 'no');`;
// $1 the folder, $2 the helper's path, $3 the bundle's byte count: written through a temp file and moved only when whole, since a wsl.exe
// killed mid-pipe ends cat's stdin early and a short helper would pass the probe forever; then every other helper-*.mjs removed. chmod
// tightens a folder mkdir found already there. umask instead of mkdir -m, and a chmod refusal passed only on a folder of our own: Git's
// sh.exe (the Windows lane's fake distro) is denied changing a profile temp folder's permissions, which a real distro never is
export const INSTALL_LINE = '(umask 077 && mkdir -p "$1") && { chmod 700 "$1" || [ -O "$1" ]; } && cat > "$2.tmp" && { [ "$(wc -c < "$2.tmp")" -eq "$3" ] || { rm -f -- "$2.tmp"; exit 1; }; } && mv -f "$2.tmp" "$2" && for f in "$1"/helper-*.mjs; do [ "$f" = "$2" ] || rm -f -- "$f"; done';

export type Probe = { folder: string; nodeVersion: string; isInstalled: boolean } | { reason: string };

/** The probe's lines: the node version first, so a node that prints only its version still reads as node_old. */
export function parseProbe(stdout: string): Probe {
  const [version, folder, installed] = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (version === undefined) return { reason: NODE_MISSING };
  const major = MAJOR.exec(version)?.[1];
  if (major === undefined) return { reason: HELPER_FAILED };
  if (Number(major) < NODE_MIN_MAJOR) return { reason: NODE_OLD };
  if (folder === undefined || !folder.endsWith(FOLDER_TAIL) || (installed !== 'yes' && installed !== 'no')) return { reason: HELPER_FAILED };
  return { folder, nodeVersion: version, isInstalled: installed === 'yes' };
}

/** A start step's failure as its reason. wsl.exe's own message is UTF-16LE; read as UTF-8 (a non -1 exit) it carries a NUL per character. */
export function startReason(err: unknown): string {
  if (!(err instanceof MachineError)) return HELPER_FAILED;
  return NO_DISTRO.test(`${err.stdout}\n${err.stderr}`.replaceAll('\0', '')) ? DISTRO_MISSING : HELPER_FAILED;
}

/** One wsl.exe exec: the probe's three lines, or why there are none. Never rejects. */
export async function probeHelper(exec: MachineExec, node: string, hash: string, signal: AbortSignal): Promise<Probe> {
  try {
    const { stdout } = await exec('sh', ['-c', LOGIN_SHELL, 'sh', PROBE_LINE, node, hash, PROBE_JS], { signal });
    return parseProbe(stdout);
  } catch (err) {
    return { reason: startReason(err) };
  }
}

/** One wsl.exe spawn whose stdin carries the bundle (decision 8): wslExec takes no input, and node:fs over \\wsl$ is never used. */
export function installHelper(deps: InstallDeps, folder: string, hash: string, bundle: Uint8Array, signal: AbortSignal): Promise<void> {
  const { file, args } = wslArgv(deps.command, deps.distro, ['sh', '-c', INSTALL_LINE, 'sh', folder, helperPath(folder, hash), String(bundle.length)]);
  const child = deps.spawn(file, args, { env: wslEnv({}, deps.env), windowsHide: true });
  return new Promise((resolve, reject) => {
    let output = '';
    const keep = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-OUTPUT_MAX); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const onAbort = (): void => { child.kill(); };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (err: Error) => {
      signal.removeEventListener('abort', onAbort);
      reject(new MachineError(`helper install: ${err.message}`, {}, { cause: err }));
    });
    child.once('close', (code: number | null) => {
      signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new MachineError(`helper install exited with ${code}`, { code: code ?? undefined, stdout: output }));
    });
    child.stdin.on('error', () => undefined); // a child that died first: its exit code says why
    child.stdin.end(bundle);
  });
}
