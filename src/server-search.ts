// The busca pane's search (#868): git grep over the activity's tree root and every nested repository under it, one process per repository,
// read as NDJSON per file. The match colouring is how one process gives both the line and every span git's own ERE matched: -o prints the
// match without its line. Every colour but the match's is pinned to normal (no escape at all), and the match's to an RGB no file plausibly holds.
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { gitIn } from './git-status.js';
import type { Machine, MachineChild } from './machine.js';
import { withMachinePath } from './machine-fs.js';
import type { TaskRouteDeps } from './server-tasks.js';
import { nestedRepos, treeMachine, treeRoot } from './server-tree.js';
import { withoutHiveEnv } from './spawn.js';
import { SEARCH_CAP, type SearchFileResult, type SearchLine, type SearchMatch, type SearchQuery } from './types.js';
import { wordsOf } from './worktree.js';

export const MATCH_START = Buffer.from('\x1b[38;2;1;2;3m');
export const MATCH_END = Buffer.from('\x1b[m');
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const NUL = 0x00;
const LF = 0x0a;
const BOM = '﻿';
const FATAL = 'fatal: ';
const PLAIN = ['filename', 'lineNumber', 'column', 'separator', 'selected', 'context', 'function', 'matchContext'];
// -c wins over the user's files: a grep.column=true or a color.grep.match of theirs changes nothing here
const PINS = [...PLAIN.map((slot) => `color.grep.${slot}=normal`), 'color.grep.matchSelected=#010203', 'grep.column=false', 'core.fsmonitor=false'];

export interface GrepLine { file: string; line: number; raw: Buffer; spans: [number, number][] }

/** git grep's argv for `cwd` (#868); paths: the replace's files, taken literally (a `:(top)` is a name). */
export function grepArgs(cwd: string, { q, isCaseSensitive, isWholeWord, isRegex }: SearchQuery, paths?: readonly string[]): string[] {
  const literal = paths === undefined ? [] : ['--literal-pathspecs'];
  const flags = [isRegex ? '-E' : '-F', ...(isCaseSensitive ? [] : ['-i']), ...(isWholeWord ? ['-w'] : [])];
  const scope = paths === undefined ? [] : ['--', ...paths];
  return ['--no-optional-locks', ...literal, '-C', cwd, ...PINS.flatMap((pin) => ['-c', pin]), 'grep', '--color=always', '-z', '-n', '-I', '--untracked', '--exclude-standard', ...flags, '-e', q, ...scope];
}

/** A coloured line without its markers (#868): the raw bytes and each match as a byte span. A start with no end after it, a raw ESC that is
 *  not the exact start marker and a lone reset outside a match all stay the line's own text. */
export function stripMatches(colored: Buffer): { raw: Buffer; spans: [number, number][] } {
  const parts: Buffer[] = [];
  const spans: [number, number][] = [];
  let size = 0;
  let at = 0;
  for (;;) {
    const start = colored.indexOf(MATCH_START, at);
    const end = start < 0 ? -1 : colored.indexOf(MATCH_END, start + MATCH_START.length);
    if (end < 0) break;
    const before = colored.subarray(at, start);
    const match = colored.subarray(start + MATCH_START.length, end);
    parts.push(before, match);
    spans.push([size + before.length, size + before.length + match.length]);
    size += before.length + match.length;
    at = end + MATCH_END.length;
  }
  parts.push(colored.subarray(at));
  return { raw: Buffer.concat(parts), spans };
}

/** Reads git grep -z's records, `path NUL line NUL text LF`, across chunks (#868). A name may hold a newline, so the fields are read in order. */
export function createGrepParser(onLine: (line: GrepLine) => void): { push(chunk: Buffer): void } {
  let pending = Buffer.alloc(0);
  const record = (): boolean => {
    const nameEnd = pending.indexOf(NUL);
    const numberEnd = nameEnd < 0 ? -1 : pending.indexOf(NUL, nameEnd + 1);
    const textEnd = numberEnd < 0 ? -1 : pending.indexOf(LF, numberEnd + 1);
    if (textEnd < 0) return false;
    const { raw, spans } = stripMatches(pending.subarray(numberEnd + 1, textEnd));
    onLine({ file: pending.subarray(0, nameEnd).toString('utf8'), line: Number(pending.subarray(nameEnd + 1, numberEnd).toString('latin1')), raw, spans });
    pending = pending.subarray(textEnd + 1);
    return true;
  };
  return {
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      while (record());
    },
  };
}

const utf16At = (raw: Buffer, byte: number): number => raw.subarray(0, byte).toString('utf8').length;

/** A line as the pane reads it (#868): UTF-16 spans; no CR of a CRLF file; line 1's BOM dropped, as the editor holds it apart. */
export function toWireMatch({ line, raw, spans }: GrepLine): SearchMatch {
  const decoded = raw.toString('utf8');
  const lead = line === 1 && decoded.startsWith(BOM) ? 1 : 0;
  const text = decoded.slice(lead).replace(/\r$/, '');
  const at = (byte: number): number => Math.min(Math.max(utf16At(raw, byte) - lead, 0), text.length);
  return { line, text, spans: spans.map(([start, end]) => [at(start), at(end)]) };
}

export function grepError(stderr: string): string {
  const fatal = stderr.split('\n').find((row) => row.startsWith(FATAL));
  return fatal?.slice(FATAL.length) ?? (stderr.trim() || 'git grep failed');
}

export type GrepOutcome = { kind: 'done' } | { kind: 'stopped' } | { kind: 'error'; message: string };
const STDERR_MAX = 64 * 1024; // enough for git's fatal line; a chatty stderr must not grow without bound
const EXIT_NO_MATCH = 1;

/** One git grep run (#868). `onLine` returning false, or an aborted signal, kills the child; the lines that arrive after are dropped. */
export function runGrep(machine: Machine, cwd: string, args: string[], onLine: (line: GrepLine) => boolean, signal: AbortSignal): Promise<GrepOutcome> {
  return new Promise((resolve) => {
    let child: MachineChild;
    try {
      child = machine.process('git', args, { cwd, env: withMachinePath(withoutHiveEnv(process.env), machine.info()) });
    } catch (err) {
      return resolve({ kind: 'error', message: wordsOf(err) }); // a remote machine's not_supported, a missing git
    }
    let isStopped = false;
    const stderr: Buffer[] = [];
    const stop = (): void => {
      if (isStopped) return;
      isStopped = true;
      child.kill();
    };
    const finish = (outcome: GrepOutcome): void => {
      signal.removeEventListener('abort', stop);
      resolve(outcome);
    };
    const parser = createGrepParser((line) => {
      if (!isStopped && !onLine(line)) stop();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (!isStopped) parser.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.reduce((size, held) => size + held.length, 0) < STDERR_MAX) stderr.push(chunk);
    });
    child.once('error', (err) => finish({ kind: 'error', message: wordsOf(err) }));
    child.once('close', (code: number | null) => {
      if (isStopped) return finish({ kind: 'stopped' });
      finish(code === 0 || code === EXIT_NO_MATCH ? { kind: 'done' } : { kind: 'error', message: grepError(Buffer.concat(stderr).toString('utf8')) });
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}

// The results of the walk, a file at a time: a file is sent when the next one starts, and when its repository ends. The counters are the
// closure's own; a file's result grows by spread
function collector(send: (line: SearchLine) => void, nested: readonly string[]) {
  let pending: SearchFileResult | undefined;
  let total = 0;
  let files = 0;
  const flush = (): void => {
    if (pending !== undefined) send(pending);
    pending = undefined;
  };
  return {
    add(repo: string, line: GrepLine): boolean {
      const match = toWireMatch(line);
      if (match.spans.length === 0) return true; // an empty ERE match gives a line with nothing to mark
      const file = repo === '' ? line.file : `${repo}/${line.file}`;
      if (repo === '' && nested.some((folder) => file.startsWith(`${folder}/`))) return true; // the nested repository's own run reports it
      if (pending?.file !== file) {
        flush();
        pending = { file, repo, matches: [] };
        files += 1;
      }
      pending = { ...pending, matches: [...pending.matches, match] };
      total += match.spans.length;
      return total < SEARCH_CAP;
    },
    flush,
    counts: () => ({ total, files }),
  };
}

// The files the search covered, the list the tree and ⌘P read; a nested repository that cannot list counts none
async function countFiles(machine: Machine, root: string, repos: readonly string[]): Promise<number> {
  const counts = await Promise.all(['', ...repos].map(async (repo) => {
    const listing = await gitIn(repo === '' ? root : join(root, repo), ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], machine.exec).catch(() => '');
    return new Set(listing.split('\0').filter((entry) => entry !== '' && !entry.endsWith('/'))).size;
  }));
  return counts.reduce((sum, count) => sum + count, 0);
}

/** The search over the tree's root, then each nested repository in path order (#868), as the lines the route writes. An abort ends it with no closing line. */
export async function searchTree(machine: Machine, root: string, query: SearchQuery, send: (line: SearchLine) => void, signal: AbortSignal, warn: (line: string) => void): Promise<void> {
  const repos = await nestedRepos(machine, root);
  if (query.q === '') return send({ done: true, total: 0, files: 0, capped: false, repos });
  const out = collector(send, repos);
  for (const repo of ['', ...repos]) {
    const cwd = repo === '' ? root : join(root, repo);
    const outcome = await runGrep(machine, cwd, grepArgs(cwd, query), (line) => out.add(repo, line), signal);
    if (signal.aborted) return;
    out.flush();
    if (outcome.kind === 'error' && repo === '') return send({ error: outcome.message });
    // Its regex passed the root's run: the failure is this repository's own (a gitdir gone), and the others still answer
    if (outcome.kind === 'error') warn(`search skipped the nested repository ${repo}`);
    if (out.counts().total >= SEARCH_CAP) break;
  }
  const { total, files } = out.counts();
  send({ done: true, total, files, capped: total >= SEARCH_CAP, repos, ...(total === 0 ? { searched: await countFiles(machine, root, repos) } : {}) });
}

const TOGGLES = ['case', 'word', 'regex'] as const;
const QUERY_MESSAGE = 'q must be one string; case, word and regex 0 or 1';

/** The query of GET /activities/:id/search (#868), or undefined when it is not well formed. */
export function searchQueryOf(raw: Request['query']): SearchQuery | undefined {
  const { q } = raw;
  if (typeof q !== 'string' || TOGGLES.some((name) => raw[name] !== undefined && raw[name] !== '0' && raw[name] !== '1')) return undefined;
  return { q, isCaseSensitive: raw.case === '1', isWholeWord: raw.word === '1', isRegex: raw.regex === '1' };
}

/** GET /activities/:id/search (#868): NDJSON, one line per file and a closing one. The tree's root is the activity's, never a request value. */
export function registerSearchRoutes(app: Express, { requireLive, machineFor, log }: Pick<TaskRouteDeps, 'requireLive' | 'machineFor' | 'log'>): void {
  app.get('/activities/:id/search', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const id = req.params.id as string;
    const root = treeRoot(current.state, current.runtime.config, id);
    if (typeof root !== 'string') return void res.status(root.status).json({ error: root.message, code: root.code, workspace: root.workspace });
    const query = searchQueryOf(req.query);
    if (query === undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: QUERY_MESSAGE });
    const machine = treeMachine(current.state, id, machineFor);
    res.status(HTTP_OK).set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const abort = new AbortController();
    res.on('close', () => abort.abort()); // the response's close is the client going away; a GET's request closes once its empty body is read
    const send = (line: SearchLine): void => void res.write(`${JSON.stringify(line)}\n`);
    try {
      await searchTree(machine, root, query, send, abort.signal, (line) => log.warn(line));
    } catch (err) {
      send({ error: wordsOf(err) });
    }
    res.end();
  });
}
