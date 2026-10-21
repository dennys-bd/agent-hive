import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Tokens } from '../facts.js';
import { cleanTitle, type TranscriptTurn } from '../usage.js';
import { eachLine, finite, isRealDir, newTally, tally, turnUsage, type UsageEntry, writtenSince } from './jsonl.js';

// Claude Code's transcripts (#924, out of usage.ts and copy-sides.ts): where it keeps them, the JSONL lines the Hive reads (usage, /rename
// titles, subagents) and the message count a copy's dialog shows.

interface TranscriptLine {
  type?: unknown;
  timestamp?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> | null };
}

// One assistant message's usage, by type with its model and time (#742). The four fields sum to ccusage's "Total Tokens", so the number the
// user sees here matches the one they know
interface AssistantUsage extends UsageEntry { tokens: number }

function parseAssistant(line: string): AssistantUsage | undefined {
  let parsed: TranscriptLine | null;
  try {
    parsed = JSON.parse(line) as TranscriptLine | null;
  } catch {
    return undefined;
  }
  if (parsed?.type !== 'assistant') return undefined;
  const message = parsed.message;
  const usage = message?.usage;
  if (typeof message?.id !== 'string' || typeof usage !== 'object' || usage === null) return undefined;
  const byType: Tokens = {
    input: finite(usage.input_tokens), output: finite(usage.output_tokens), cache_write: finite(usage.cache_creation_input_tokens), cache_read: finite(usage.cache_read_input_tokens),
  };
  const at = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
  const tokens = byType.input + byType.output + byType.cache_write + byType.cache_read;
  return { id: message.id, tokens, byType, at, ...(typeof message.model === 'string' ? { model: message.model } : {}) };
}

/** One transcript line → its usage, or nothing. The same `message.id` repeats once per content block; the caller dedupes. */
export function parseUsageLine(line: string): { id: string; tokens: number } | undefined {
  const usage = parseAssistant(line);
  return usage === undefined ? undefined : { id: usage.id, tokens: usage.tokens };
}

// One transcript line → its /rename title (#489), or nothing: Claude Code appends {"type":"custom-title","customTitle":"…"} at every rename.
function parseTitleLine(line: string): string | undefined {
  let parsed: { type?: unknown; customTitle?: unknown } | null;
  try {
    parsed = JSON.parse(line) as { type?: unknown; customTitle?: unknown } | null;
  } catch {
    return undefined;
  }
  return parsed?.type === 'custom-title' ? cleanTitle(parsed.customTitle) : undefined;
}

// Claude Code writes each subagent's transcript to <transcript dir>/<session_id>/subagents/agent-<id>.jsonl, beside the main one. Only the
// .jsonl regular files directly in that folder, through no linked folder: anything else is not this session's. No folder: none. A file
// last written before the stage run holds none of its turns, so it is never opened: an old session's subagents would slow every Stop
async function subagentTranscripts(path: string, since: number): Promise<string[]> {
  const session = join(dirname(path), basename(path, '.jsonl'));
  const dir = join(session, 'subagents');
  if (!(await isRealDir(session)) || !(await isRealDir(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  // readdir's order is the file system's (APFS sorts, ext4 does not): sorted, so the models list the same on every machine
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => join(dir, e.name)).sort();
  const fresh = await Promise.all(files.map((file) => writtenSince(file, since)));
  return files.filter((_, i) => fresh[i]);
}

/**
 * Sums the tokens of every assistant message in a Claude Code transcript, counting each `message.id` once, and keeps the last /rename
 * title, in one pass. With `since`, the messages at or after it also add up by type with their models (#742), the session's subagent
 * transcripts included: a resumed session's older turns are not the stage run's. The session total (budgets, Worker.tokens) stays the main
 * transcript's alone. Rejects when the file cannot be opened or read; the server treats that as "no tokens and no title this turn".
 * ponytail: reads the whole file at every turn end; if transcripts ever weigh, keep a byte offset per worker and tail from it.
 */
export async function readTranscript(path: string, since?: number): Promise<TranscriptTurn> {
  const stage = newTally();
  const seen = new Set<string>();
  let total = 0;
  let title: string | undefined;
  await eachLine(path, (line) => {
    // Only a line naming the type is parsed a second time. A title cleaned to nothing keeps the one before: a rename never clears a name (#489)
    const renamed = line.includes('"custom-title"') ? parseTitleLine(line) : undefined;
    if (renamed !== undefined) {
      title = renamed;
      return;
    }
    const usage = parseAssistant(line);
    if (!usage || seen.has(usage.id)) return;
    seen.add(usage.id);
    total += usage.tokens;
    if (since !== undefined) tally(stage, usage, since, false);
  });
  // Finite fields can still overflow the sum; nothing non-finite may reach State.usage or it jams every budget check
  if (!Number.isFinite(total)) throw new Error(`${path}: token total is not finite`);
  const base = { tokens: total, ...(title === undefined ? {} : { title }) };
  if (since === undefined) return base;
  // A subagent file that fails to read costs only its own share, never the turn's session total
  // One after the other, in name order: the tokens would add up in any order, but the models list in the order they are met
  for (const sub of await subagentTranscripts(path, since)) {
    await eachLine(sub, (line) => tally(stage, parseAssistant(line), since, true)).catch(() => undefined);
  }
  return { ...base, usage: turnUsage(stage) };
}

/** Where Claude Code keeps the transcripts of a cwd: `<config dir>/projects/<cwd with every non-alphanumeric as '-'>`. An empty or relative
 * CLAUDE_CONFIG_DIR falls back to ~/.claude: it would resolve against the daemon's cwd, not Claude Code's, and removeTranscripts deletes there (#236). */
export function transcriptDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), '.claude');
  return join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** A transcript the Claude run of `cwd` owns (#929, out of usage.ts and server.ts): directly in its transcript dir and, with a session id, that
 * session's own file, never the checkout's other transcripts (#590). */
export function ownsTranscript(path: string, cwd: string, sessionId: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return dirname(path) === transcriptDir(cwd, env) && (sessionId === undefined || basename(path) === `${sessionId}.jsonl`);
}

/** What deleting a session's transcripts removes (#236): <id>.jsonl and <id>/, its subagents', in the transcript dir of `cwd`. */
export function sessionFiles(cwd: string, id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = transcriptDir(cwd, env);
  return [join(dir, `${id}.jsonl`), join(dir, id)];
}

const messageId = (line: string): { user: boolean; assistant?: string } => {
  try {
    const { type, message } = JSON.parse(line) as { type?: unknown; message?: { id?: unknown; content?: unknown } };
    if (type === 'user') return { user: typeof message?.content === 'string' };
    return { user: false, ...(type === 'assistant' && typeof message?.id === 'string' ? { assistant: message.id } : {}) };
  } catch {
    return { user: false }; // a half-written last line
  }
};

/** The user's prompts plus each assistant message once, not tool results nor metadata (#587). */
// ponytail: reads the whole transcript once per dialog open; stream it as readTranscript does if transcripts ever weigh
export async function countMessages(path: string): Promise<number> {
  if (!(await stat(path)).isFile()) throw new Error(`${path}: not a regular file`);
  const seen = new Set<string>();
  let users = 0;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const { user, assistant } = messageId(line);
    if (user) users += 1;
    if (assistant !== undefined) seen.add(assistant);
  }
  return users + seen.size;
}
