// The fake wsl.exe (#939) as a distro whose home is a temp folder (#945): what the helper's probe, install, link and machine tests share.
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { SpawnChild } from '../src/wsl/helper-install.js';
import type { WslDeps } from '../src/wsl/wsl-exe.js';

export const FAKE_WSL = fileURLToPath(new URL('./fake-wsl.js', import.meta.url));
export const DISTRO = 'Debian';
export const runBuffer = promisify(execFile) as unknown as WslDeps['run'];
export const spawnChild: SpawnChild = (file, args, options) => spawn(file, args, options);

/** The fake wsl.exe's deps with `home` as the distro's HOME: the fake reads FAKE_WSL_HOME from the env wsl.exe starts with. */
export const fakeWslDeps = (home: string, env: NodeJS.ProcessEnv = {}): WslDeps =>
  ({ command: [process.execPath, FAKE_WSL], run: runBuffer, env: { ...process.env, ...env, FAKE_WSL_HOME: home } });
