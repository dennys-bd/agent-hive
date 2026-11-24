// The fake wsl.exe (#939) as a distro whose home is a temp folder (#945): what the helper's probe, install, link and machine tests share.
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SpawnChild } from '../src/wsl/helper-install.js';
import type { WslDeps } from '../src/wsl/wsl-exe.js';
import { type AfterHost, tempDir } from './temp-dir.js';

export const FAKE_WSL = fileURLToPath(new URL('./fake-wsl.js', import.meta.url));
export const DISTRO = 'Debian';
export const runBuffer = promisify(execFile) as unknown as WslDeps['run'];
export const spawnChild: SpawnChild = (file, args, options) => spawn(file, args, options);

/** The fake wsl.exe's deps with `home` as the distro's HOME: the fake reads FAKE_WSL_HOME from the env wsl.exe starts with. */
export const fakeWslDeps = (home: string, env: NodeJS.ProcessEnv = {}): WslDeps =>
  ({ command: [process.execPath, FAKE_WSL], run: runBuffer, env: { ...process.env, ...env, FAKE_WSL_HOME: home } });

const ROOT = fileURLToPath(new URL('../../', import.meta.url)); // this file runs from dist/test/: the repo is two levels up

/** The helper's bundle, built from today's src/ into a temp folder of the caller's: the CI lanes run tsc alone, and dist's could be old. */
export async function buildHelperBundle(host: AfterHost): Promise<string> {
  const dir = await tempDir(host, 'wsl-bundle-');
  await promisify(execFile)(process.execPath, [join(ROOT, 'scripts', 'build-wsl-helper.mjs'), dir], { cwd: ROOT });
  return join(dir, 'wsl-helper.mjs');
}

/** A helper that never says hello and ends when its stdin does, as the real one: a killed wsl.exe leaves it nothing else to end on. */
export const MUTE_HELPER = 'process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));\n';
