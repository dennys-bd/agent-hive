// POST /activities/:id/search/replace (#868): the busca pane's replace. The request only limits git's pathspec; the spans come from a fresh
// git grep run at write time, so a line the file no longer holds as git printed it is skipped, never overwritten.
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { decodeText } from './decode-text.js';
import type { Machine } from './machine.js';
import { MachineError } from './machine.js';
import { machineCode } from './machine-fs.js';
import { sha256 } from './server-editor.js';
import { grepArgs, type GrepLine, runGrep } from './server-search.js';
import type { TaskRouteDeps } from './server-tasks.js';
import { nestedRepos, treeMachine, treeRoot } from './server-tree.js';
import { EDITOR_FILE_MAX, type ReplaceAnswer, type ReplaceRequest, type ReplaceSkip, SEARCH_CAP } from './types.js';
import { wordsOf } from './worktree.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
const OWNER_WRITE = 0o200;
const LF = 0x0a;
const BODY_MESSAGE = 'query.q, replacement and 1 to 2000 files are required';

/** A line's bytes with each span replaced by the replacement, literally (#868). Spans are ascending byte offsets into `raw`. */
export function replaceLine(raw: Buffer, spans: readonly [number, number][], replacement: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  for (const [start, end] of spans) {
    parts.push(raw.subarray(at, start), replacement);
    at = end;
  }
  parts.push(raw.subarray(at));
  return Buffer.concat(parts);
}

/** The file with the reported lines replaced, or undefined when one of them is no longer as git printed it (#868). A CRLF line keeps its CR. */
export function replaceInBytes(bytes: Buffer, lines: readonly GrepLine[], replacement: Buffer): Buffer | undefined {
  const reported = new Map(lines.map((line) => [line.line, line]));
  const parts: Buffer[] = [];
  let seen = 0;
  let at = 0;
  for (let number = 1; ; number += 1) {
    const lf = bytes.indexOf(LF, at);
    const row = bytes.subarray(at, lf < 0 ? bytes.length : lf);
    const line = reported.get(number);
    if (line !== undefined && !row.equals(line.raw)) return undefined;
    if (line !== undefined) seen += 1;
    parts.push(line === undefined ? row : replaceLine(row, line.spans, replacement));
    if (lf < 0) break;
    parts.push(bytes.subarray(lf, lf + 1));
    at = lf + 1;
  }
  return seen === reported.size ? Buffer.concat(parts) : undefined;
}

/** The body of the route (#868), or undefined when it is not well formed. */
export function replaceRequestOf(raw: unknown): ReplaceRequest | undefined {
  const { query, replacement, files } = (raw ?? {}) as Record<string, unknown>;
  const q = (query ?? {}) as Record<string, unknown>;
  const isQuery = typeof q.q === 'string' && q.q !== '' && typeof q.isCaseSensitive === 'boolean' && typeof q.isWholeWord === 'boolean' && typeof q.isRegex === 'boolean';
  const isFiles = Array.isArray(files) && files.length > 0 && files.length <= SEARCH_CAP && files.every((file) => typeof file === 'string' && file !== '');
  if (!isQuery || typeof replacement !== 'string' || !isFiles) return undefined;
  return { query: { q: q.q as string, isCaseSensitive: q.isCaseSensitive as boolean, isWholeWord: q.isWholeWord as boolean, isRegex: q.isRegex as boolean }, replacement, files: files as string[] };
}

type Outcome = ReplaceAnswer['changed'][number] | ReplaceSkip;

// One file: the checks of the editor's save, then the replace and the atomic write
async function replaceOne(machine: Machine, file: string, lines: readonly GrepLine[], replacement: Buffer): Promise<Outcome> {
  if (!(await machine.fs.lstat(file)).isFile()) return 'not_text'; // a symlink or a folder is not the file git searched
  const { size, mode } = await machine.fs.stat(file);
  if (size > EDITOR_FILE_MAX) return 'too_large';
  if ((mode & OWNER_WRITE) === 0) return 'read_only';
  const bytes = await machine.fs.readFile(file, { maxBytes: EDITOR_FILE_MAX }).catch((err: unknown) => {
    if (machineCode(err) === MachineError.TOO_LARGE) return 'too_large' as const;
    throw err;
  });
  if (typeof bytes === 'string') return bytes;
  const previous = decodeText(bytes);
  if (previous === undefined) return 'not_text';
  const replaced = replaceInBytes(bytes, lines, replacement);
  if (replaced === undefined) return 'changed';
  const text = decodeText(replaced);
  if (text === undefined) return 'not_text';
  const written = await machine.fs.writeAtomic(file, text);
  return { path: '', previous, version: sha256(written), count: lines.reduce((sum, line) => sum + line.spans.length, 0) };
}

// The files by repository, the longest repository prefix first: a file of docs/ is the nested repository's, not the root's
function groupByRepo(files: readonly string[], repos: readonly string[]): Map<string, string[]> {
  const ordered = [...repos].sort((a, b) => b.length - a.length);
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const repo = ordered.find((candidate) => file.startsWith(`${candidate}/`)) ?? '';
    groups.set(repo, [...(groups.get(repo) ?? []), repo === '' ? file : file.slice(repo.length + 1)]);
  }
  return groups;
}

// What git finds now in the requested files, by wire path; git's reason when a run fails
async function grepNow(machine: Machine, root: string, request: ReplaceRequest, repos: readonly string[]): Promise<Map<string, GrepLine[]> | { error: string }> {
  const found = new Map<string, GrepLine[]>();
  for (const [repo, paths] of groupByRepo(request.files, repos)) {
    const cwd = repo === '' ? root : join(root, repo);
    const outcome = await runGrep(machine, cwd, grepArgs(cwd, request.query, paths), (line) => {
      const path = repo === '' ? line.file : `${repo}/${line.file}`;
      found.set(path, [...(found.get(path) ?? []), line]);
      return true;
    }, new AbortController().signal);
    if (outcome.kind === 'error') return { error: outcome.message };
  }
  return found;
}

/** Re-greps the files and replaces what git reports (#868). The paths written are git's, joined to `root`, never the request's. */
export async function replaceFiles(machine: Machine, root: string, request: ReplaceRequest): Promise<ReplaceAnswer | { error: string }> {
  const found = await grepNow(machine, root, request, await nestedRepos(machine, root));
  if (!(found instanceof Map)) return found;
  const replacement = Buffer.from(request.replacement, 'utf8');
  const changed: ReplaceAnswer['changed'] = [];
  const skipped: ReplaceAnswer['skipped'] = [];
  for (const path of [...found.keys()].sort()) {
    const outcome = await replaceOne(machine, join(root, ...path.split('/')), found.get(path) ?? [], replacement);
    if (typeof outcome === 'string') skipped.push({ path, reason: outcome });
    else changed.push({ ...outcome, path });
  }
  return { changed, skipped };
}

/** POST /activities/:id/search/replace (#868). Run mode's middleware gates every viewer POST, this one included. */
export function registerReplaceRoute(app: Express, { requireLive, machineFor }: Pick<TaskRouteDeps, 'requireLive' | 'machineFor'>): void {
  app.post('/activities/:id/search/replace', async (req: Request, res: Response) => {
    const current = requireLive(res);
    if (!current) return;
    const id = req.params.id as string;
    const root = treeRoot(current.state, current.runtime.config, id);
    if (typeof root !== 'string') return void res.status(root.status).json({ error: root.message, code: root.code, workspace: root.workspace });
    const request = replaceRequestOf(req.body);
    if (request === undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: BODY_MESSAGE });
    try {
      const answer = await replaceFiles(treeMachine(current.state, id, machineFor), root, request);
      if ('error' in answer) res.status(HTTP_BAD_REQUEST).json(answer);
      else res.json(answer);
    } catch (err) {
      res.status(HTTP_SERVER_ERROR).json({ error: wordsOf(err) });
    }
  });
}
