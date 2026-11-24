// The WSL lane's run (#948): the tests of test/wsl-real/, which need a real distro and which no glob of test-node.mjs reaches, so no other
// lane and no test:affected selection runs them. A lane that lost its distro or its tests is refused, red, never an empty green.
import { globSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { DIST, runFiles } from './test-node.mjs';

export const WSL_GLOB = 'test/wsl-real/*.test.js';
// a hung wsl.exe fails its test by name inside the job's timeout; --test-force-exit ends a file whose handle stays open (see test-node.mjs)
const TIMEOUT = ['--test-timeout=300000', '--test-force-exit'];
// one file at a time: every file starts machines in the same distro, whose Hive folder (hooks.json, relay-port) and ~/.local/bin they share
const SERIAL = ['--test-concurrency=1'];

// globSync answers with the platform's separator; the sort and the runner speak `/`
export const wslFiles = (root) => globSync(WSL_GLOB, { cwd: root }).map((file) => file.split(sep).join('/')).sort();

function refuse(line) {
  console.error(line);
  process.exitCode = 1;
}

function run(args) {
  // root: a dist/-shaped tree other than dist/, for test-wsl.test.ts's own runs
  const { values } = parseArgs({ args, options: { root: { type: 'string' } }, strict: true });
  const root = values.root ?? DIST;
  if ((process.env.HIVE_WSL_DISTRO ?? '') === '') return refuse('test-wsl: HIVE_WSL_DISTRO is empty: the lane has no distro to test');
  const files = wslFiles(root);
  if (files.length === 0) return refuse(`test-wsl: no *.test.js under ${join(root, 'test', 'wsl-real')}`);
  runFiles({ root, files, args: [...TIMEOUT, ...SERIAL] });
}

if (import.meta.main) run(process.argv.slice(2));
