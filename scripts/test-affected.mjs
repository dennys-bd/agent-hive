// The local test run of a worktree (#867): only the tests the branch affects, at a quarter of the cores, so several worktrees can test at once.
// CI still runs the whole suite (`pnpm test`); this is what a worker runs before a commit.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DIST, ROOT, runFiles, testFiles } from './test-node.mjs';

const BASE_REF = 'origin/main';
const CORES_PER_WORKER = 4;
// tsc's output keeps every runtime edge and erases `import type`: a static or dynamic import, a re-export and a file read through new URL
const EDGES = [/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g, /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url/g];
const COMPILED = /\.(c|m)?ts$/;

export const workers = (cores) => Math.max(1, Math.floor(cores / CORES_PER_WORKER));

/** The branch's changes: the diff against the merge-base (committed, staged and unstaged) plus the untracked files. */
export function changedFiles(git) {
  try {
    const base = git(['merge-base', 'HEAD', BASE_REF]).trim();
    const diff = git(['diff', '--name-only', base]);
    const untracked = git(['ls-files', '--others', '--exclude-standard']);
    const files = [...new Set(`${diff}\n${untracked}`.split('\n').filter(Boolean))].sort();
    return { base, files };
  } catch (error) {
    console.error(`test-affected: no merge-base with ${BASE_REF}, running everything (${error.message})`);
    return { base: null, files: [] };
  }
}

// A test that reads a file outside src/ and test/ (a plugin template, a config) has no import edge to it, so such a change runs every test
const blinds = (file) => !file.startsWith('src/') && !file.startsWith('test/') && !file.endsWith('.md');

function edgesOf(file) {
  const text = readFileSync(file, 'utf8');
  return EDGES.flatMap((edge) => [...text.matchAll(edge)].map((match) => resolve(dirname(file), match[1])));
}

// One read per file for the whole selection: most tests share most of their closure
function edgeCache() {
  const known = new Map();
  return (file) => {
    if (!known.has(file)) known.set(file, edgesOf(file));
    return known.get(file);
  };
}

// Every file a test reaches, walked through the compiled JS; a path outside dist/ (a .ts read by URL, a fixture .mjs) is a leaf
function reaches(start, root, edges) {
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.startsWith(root + sep) && /\.(c|m)?js$/.test(file) && existsSync(file)) stack.push(...edges(file));
  }
  return seen;
}

// A changed source counts as itself and, for a .ts under src/ or test/, as the JS tsc compiled it to
function targets({ repo, root, changed }) {
  return new Set(changed.flatMap((file) => {
    const own = join(repo, file);
    if (!COMPILED.test(file)) return [own];
    return [own, join(root, file.replace(COMPILED, (_, kind) => `.${kind ?? ''}js`))];
  }));
}

export function selectTests({ repo, root, changed }) {
  const blind = changed.find(blinds);
  if (blind !== undefined) return { full: blind };
  const hit = targets({ repo, root, changed });
  if (hit.size === 0) return { files: [] };
  const edges = edgeCache();
  const files = testFiles({ root }).filter((test) => [...reaches(join(root, test), root, edges)].some((file) => hit.has(file)));
  return { files };
}

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function runNode(changes, count) {
  const args = [`--test-concurrency=${count}`];
  if (changes.base === null) return runFiles({ root: DIST, files: testFiles({ root: DIST }), args });
  const selection = selectTests({ repo: ROOT, root: DIST, changed: changes.files });
  if ('full' in selection) {
    console.log(`test-affected: ${selection.full} is outside src/ and test/, running every node test`);
    return runFiles({ root: DIST, files: testFiles({ root: DIST }), args });
  }
  console.log(`test-affected: ${selection.files.length} affected node tests`);
  if (selection.files.length === 0) return;
  runFiles({ root: DIST, files: selection.files, args });
}

// vitest follows its own module graph from the changed files, but --changed ignores forceRerunTriggers (vitest 5.0): the same blind rule
// as the node suite turns a config or package.json change into the whole run
function runVitest(changes, count) {
  const blind = changes.files.find(blinds);
  if (blind !== undefined) console.log(`test-affected: ${blind} is outside src/ and test/, running every vitest test`);
  const changed = changes.base === null || blind !== undefined ? [] : [`--changed=${changes.base}`];
  const bin = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const child = spawn(process.execPath, [bin, 'run', ...changed, `--maxWorkers=${count}`, '--passWithNoTests'], { cwd: ROOT, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

const SUITES = { node: runNode, vitest: runVitest };

if (import.meta.main) {
  const suite = SUITES[process.argv[2]];
  if (suite === undefined) {
    console.error('usage: node scripts/test-affected.mjs node|vitest');
    process.exitCode = 2;
  } else suite(changedFiles(git), workers(availableParallelism()));
}
