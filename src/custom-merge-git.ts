// git as the update merge's engine (#324): merge-file for the three-way merge, diff --no-index for the clean changes. execFile with argv
// arrays only; the texts reach git as files in the caller's temp folder, under fixed names that never read as an option.
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDiff } from './diff.js';
import type { DiffHunk, DiffLine, UpdateChoice } from './types.js';

/** Longer than any run of < | = > a skill or specialist holds, so a line of the user's is never read as a marker. */
export const MARKER_SIZE = 41;
const GIT_MAX_BYTES = 16 * 1024 * 1024; // an item's files are small; this only turns a runaway file into an error
const GIT_FAILED = 128; // from 128 up git itself failed; below, merge-file's exit code is its count of conflicts
const MAX_COUNT = 127; // merge-file truncates its count there
const FILES_DIFFER = 1; // diff --no-index's answer for two files that differ
const HUNK_RANGE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export interface Conflict {
  mine: string[];
  base: string[];
  hive: string[];
}
export type Segment = string | Conflict; // a string is one merged line, with its own line ending
export interface Hunk {
  fromAbove: number;
  toAbove: number;
  removed: string[];
  added: string[];
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: GIT_MAX_BYTES }, (err, stdout, stderr) => {
      if (err === null) return resolve({ code: 0, stdout, stderr });
      // An exit code is git's answer; anything else (git missing, a signal, the output past maxBuffer) is a failure
      if (typeof err.code !== 'number') return reject(err);
      resolve({ code: err.code, stdout, stderr });
    });
  });
}

const isMarker = (line: string, char: string): boolean => line.startsWith(char.repeat(MARKER_SIZE)) && line.charAt(MARKER_SIZE) !== char;
const linesOf = (text: string): string[] => text.split(/(?<=\n)/).filter((line) => line !== '');

/** merge-file --diff3 output as merged lines and conflict blocks, every line with its own ending. Throws on a block left open. */
export function parseMerge(text: string): Segment[] {
  const segments: Segment[] = [];
  let block: Conflict | undefined;
  let side: keyof Conflict = 'mine';
  for (const line of linesOf(text)) {
    if (block === undefined && isMarker(line, '<')) {
      block = { mine: [], base: [], hive: [] };
      side = 'mine';
    } else if (block === undefined) segments.push(line);
    else if (isMarker(line, '|')) side = 'base';
    else if (isMarker(line, '=')) side = 'hive';
    else if (isMarker(line, '>')) {
      segments.push(block);
      block = undefined;
    } else block[side].push(line);
  }
  if (block !== undefined) throw new Error('git merge-file left a conflict open');
  return segments;
}

/** The three-way merge of the version's text (mine), its base and the shipped text (hive); --diff3 gives each conflict its base side. */
export async function mergeTexts(dir: string, mine: Buffer, base: Buffer, hive: Buffer): Promise<Segment[]> {
  await Promise.all([writeFile(join(dir, 'mine'), mine), writeFile(join(dir, 'base'), base), writeFile(join(dir, 'hive'), hive)]);
  const run = await git(dir, ['merge-file', '-p', '--diff3', `--marker-size=${MARKER_SIZE}`, '-L', 'mine', '-L', 'base', '-L', 'hive', 'mine', 'base', 'hive']);
  if (run.code >= GIT_FAILED) throw new Error(`git merge-file failed (${run.code}): ${run.stderr.trim()}`);
  const segments = parseMerge(run.stdout);
  const count = segments.filter((segment) => typeof segment !== 'string').length;
  if (Math.min(count, MAX_COUNT) !== run.code) throw new Error(`git merge-file counted ${run.code} conflicts, its output holds ${count}`);
  return segments;
}

/** The merge's text with each conflict, by its index, replaced by the side `pick` chooses for it. */
export function resolveMerge(segments: readonly Segment[], pick: (n: number) => UpdateChoice): string {
  let n = -1;
  return segments
    .map((segment) => {
      if (typeof segment === 'string') return segment;
      n += 1;
      return segment[pick(n)].join('');
    })
    .join('');
}

// A -U0 range `-a,b`, b being 1 when left out: with b = 0 the hunk sits after line a, else it starts on it
const linesAbove = (start: string | undefined, count: string | undefined): number => Number(start ?? 0) - (count === '0' ? 0 : 1);

function toHunk(hunk: DiffHunk): Hunk {
  const [, fromStart, fromCount, toStart, toCount] = HUNK_RANGE.exec(hunk.header) ?? [];
  const text = (kind: DiffLine['kind']): string[] => hunk.lines.filter((line) => line.kind === kind).map((line) => line.text.replace(/\r$/, ''));
  return { fromAbove: linesAbove(fromStart, fromCount), toAbove: linesAbove(toStart, toCount), removed: text('del'), added: text('add') };
}

/** The changes from one text to another, as git diff -U0 hunks. */
export async function diffTexts(dir: string, from: Buffer, to: Buffer): Promise<Hunk[]> {
  await Promise.all([writeFile(join(dir, 'from'), from), writeFile(join(dir, 'to'), to)]);
  const run = await git(dir, ['diff', '--no-index', '--no-ext-diff', '--no-color', '-U0', 'from', 'to']);
  if (run.code !== 0 && run.code !== FILES_DIFFER) throw new Error(`git diff failed (${run.code}): ${run.stderr.trim()}`);
  return parseDiff(run.stdout).flatMap((file) => file.hunks.map(toHunk));
}
