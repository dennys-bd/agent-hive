// The node test run (#624): which files run, in plain node so cmd, PowerShell and sh run it alike. The only place the globs are written.
import { spawn } from 'node:child_process';
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const GLOBS = Object.freeze([
  'test/*.test.js',
  'test/agents/*.test.js',
  'test/sources/*.test.js',
  'test/benchmark/*.test.js',
  'test/repos/*.test.js',
  'test/read-model/*.test.js',
]);

function listed(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim().replaceAll('\\', '/')).filter((line) => line !== '' && !line.startsWith('#'));
}

// globSync answers with the platform's separator; lists, excludes and the sort all speak `/`
const globbed = (root) => GLOBS.flatMap((glob) => globSync(glob, { cwd: root }).map((file) => file.split(sep).join('/')));

export function testFiles({ root, list, exclude = [] }) {
  const picked = list === undefined ? globbed(root) : listed(list);
  const missing = picked.filter((file) => !existsSync(join(root, file)));
  if (missing.length > 0) throw new Error(`test-node: listed files missing under ${root}: ${missing.join(', ')}`);
  // sorted, so a shard holds the same files on macOS and Linux
  const files = [...new Set(picked)].filter((file) => !exclude.some((glob) => matchesGlob(file, glob))).sort();
  if (files.length === 0) throw new Error('test-node: no test file selected');
  return files;
}

// the repo root, as the old `node --test dist/...` line ran from it: tests that read process.cwd() keep seeing the root
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(ROOT, 'dist');
// test-timeout is passed through because NODE_OPTIONS refuses it (#654). With it goes --test-force-exit: a timed-out test whose
// handle stays open (a timer, a child) otherwise keeps its file's process, and the runner, alive
// --junit puts the reporters on this argv, not in NODE_OPTIONS: a test that runs its own node --test would inherit them and write over the report
const OPTIONS = { shard: { type: 'string' }, list: { type: 'string' }, exclude: { type: 'string', multiple: true }, 'test-timeout': { type: 'string' }, junit: { type: 'string' } };

// Every boot copies the Hive's plugin into CODEX_HOME (#934), so a run gets a throwaway one and never touches the user's.
function run(args) {
  const { values } = parseArgs({ args, options: OPTIONS, strict: true });
  const files = testFiles({ root: DIST, list: values.list, exclude: values.exclude });
  const shard = values.shard === undefined ? [] : [`--test-shard=${values.shard}`];
  const timeout = values['test-timeout'] === undefined ? [] : [`--test-timeout=${values['test-timeout']}`, '--test-force-exit'];
  const junit = values.junit === undefined ? [] : ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${values.junit}`];
  const home = mkdtempSync(join(tmpdir(), 'hive-test-'));
  const child = spawn(process.execPath, ['--test', ...shard, ...timeout, ...junit, ...files.map((file) => `dist/${file}`)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude') },
  });
  // the home goes only once the child is gone, so a test still writing into it never loses it mid-write
  // a handle still open in the home (win32, an antivirus) must not turn the run's result into an uncaught throw
  const finish = (code) => {
    process.exitCode = code;
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.error(`test-node: could not remove ${home}: ${error.message}`);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(`test-node: ${error.message}`);
    finish(1);
  });
  child.on('exit', (code) => finish(code ?? 1));
}

if (import.meta.main) run(process.argv.slice(2));
