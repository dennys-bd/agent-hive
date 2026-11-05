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
  return readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
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

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const OPTIONS = { shard: { type: 'string' }, list: { type: 'string' }, exclude: { type: 'string', multiple: true } };

// Every boot copies the Hive's plugin into CODEX_HOME (#934), so a run gets a throwaway one and never touches the user's.
function run(args) {
  const { values } = parseArgs({ args, options: OPTIONS, strict: true });
  const files = testFiles({ root: DIST, list: values.list, exclude: values.exclude });
  const shard = values.shard === undefined ? [] : [`--test-shard=${values.shard}`];
  const home = mkdtempSync(join(tmpdir(), 'hive-test-'));
  const child = spawn(process.execPath, ['--test', ...shard, ...files], {
    cwd: DIST,
    stdio: 'inherit',
    env: { ...process.env, CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude') },
  });
  // the home goes only once the child is gone, so a test still writing into it never loses it mid-write
  const finish = (code) => {
    rmSync(home, { recursive: true, force: true });
    process.exitCode = code;
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    console.error(`test-node: ${error.message}`);
    finish(1);
  });
  child.on('exit', (code) => finish(code ?? 1));
}

if (import.meta.main) run(process.argv.slice(2));
