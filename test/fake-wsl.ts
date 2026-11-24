// A stand-in for wsl.exe (#939), run as `node dist/test/fake-wsl.js`. It speaks the three calls the Hive makes: `-l -q`, `-l --running -q`
// (#946) and `-d <distro> --exec <argv>`. The "distro" is the host itself: the argv runs as given, with no shell, so the tests prove the
// Hive's argv on every OS, Windows CI included.
import { spawnSync } from 'node:child_process';
import { posixShell, posixShellEnv } from '../src/posix-shell.js';

const utf16 = (text: string): Buffer => Buffer.from(text, 'utf16le');
const args = process.argv.slice(2);
const names = (value: string | undefined): string[] | undefined => value?.split(',').filter(Boolean);
const distros = names(process.env.FAKE_WSL_DISTROS);
const running = names(process.env.FAKE_WSL_RUNNING) ?? distros; // #946: unset, every installed distro runs

function listDistros(listed: string[] | undefined): number {
  if (listed === undefined) {
    process.stdout.write(utf16('Windows Subsystem for Linux has no installed distributions.\r\n'));
    return 1;
  }
  // wsl.exe ends the list with CR LF per name; a stray NUL is what its UTF-16 output sometimes carries
  process.stdout.write(utf16(`${listed.map((d) => `${d}\r\n`).join('')}\0`));
  return 0;
}

// What a real distro's process would have: only the variables WSLENV names. PATH and SystemRoot of the host stand in for the distro's own
// PATH and are what a process needs to start on Windows (SystemRoot) or to find touch and cat (PATH). FAKE_WSL_HOME (#945) is the distro's
// home for a test that starts the helper (USERPROFILE too: homedir() reads it on win32), and the temp names give its node a temp folder
const TEMP_NAMES = ['TEMP', 'TMP', 'TMPDIR'];
function distroEnv(): NodeJS.ProcessEnv {
  const named = (process.env.WSLENV ?? '').split(':').filter(Boolean);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...posixShellEnv(process.platform) };
  if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  const home = process.env.FAKE_WSL_HOME;
  if (home !== undefined) {
    Object.assign(env, { HOME: home, USERPROFILE: home });
    for (const name of TEMP_NAMES) if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of named) env[name] = process.env[name];
  return env;
}

function exec(distro: string, argv: string[]): number {
  if (distros !== undefined && !distros.includes(distro)) {
    process.stdout.write(utf16('There is no distribution with the supplied name.\r\n'));
    return 1;
  }
  const [file, ...rest] = argv;
  if (file === undefined) return 1;
  const result = spawnSync(file === 'sh' ? posixShell().shell : file, rest, { stdio: 'inherit', env: distroEnv() });
  return result.status ?? 1;
}

if (args[0] === '-l' && args[1] === '-q') process.exitCode = listDistros(distros);
else if (args[0] === '-l' && args[1] === '--running' && args[2] === '-q') process.exitCode = listDistros(running);
else if (args[0] === '-d' && args[2] === '--exec') process.exitCode = exec(args[1] ?? '', args.slice(3));
else process.exitCode = 2;
