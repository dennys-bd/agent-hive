// The node test run (#624): which files run, in plain node so cmd, PowerShell and sh run it alike. The only place the globs are written.
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, matchesGlob, sep } from 'node:path';

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
