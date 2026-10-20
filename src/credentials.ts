import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hiveHome } from './home.js';
import type { Credentials } from './types.js';

const FILE_NAME = 'credentials.json';
const DIR_MODE = 0o700; // same protection `gh` uses by default: per user, outside the workspace tree and outside git
const FILE_MODE = 0o600;

/** `<hiveHome>/credentials.json`. Per user, so one login serves every workspace; hiveHome owns the XDG rule. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hiveHome(env), FILE_NAME);
}

// A malformed `github` field (wrong shape, or a token/login that isn't a string) is dropped rather than trusted: a
// non-string token would stringify as `Bearer [object Object]` in the Authorization header, and a non-string login
// would be echoed as is into GET /settings/github/auth.
function isGithubCredential(value: unknown): value is { token: string; login: string } {
  if (typeof value !== 'object' || value === null) return false;
  const { token, login } = value as { token?: unknown; login?: unknown };
  return typeof token === 'string' && typeof login === 'string';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// #333: an external server's header value by server name; an entry whose value is not a string is dropped, as a malformed github is: it
// would reach a header as [object Object]. A map that is no object is dropped whole.
function mcpValues(raw: unknown): Record<string, { value: string }> | undefined {
  if (!isRecord(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw).flatMap(([name, entry]) => (isRecord(entry) && typeof entry.value === 'string' ? [[name, { value: entry.value }]] : [])));
}

/**
 * What is stored, `{}` when nothing is. A missing, unreadable or corrupt file reads as "not logged in", never as a
 * boot failure. A `github` field with a non-string token or login is dropped the same way (the `mcp` map is kept entry by entry, #333), but in place: every other
 * top-level key (a sibling provider's, once one exists) is kept, since `writeCredentials({ ...await readCredentials(),
 * github }, …)` is the write pattern every login uses — losing a sibling here would silently erase it on the next one.
 */
export async function readCredentials(env?: NodeJS.ProcessEnv): Promise<Credentials> {
  const text = await readFile(credentialsPath(env), 'utf8').catch(() => undefined);
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const { github, mcp, ...rest } = parsed as { github?: unknown; mcp?: unknown } & Record<string, unknown>;
    const values = mcpValues(mcp);
    return { ...rest, ...(isGithubCredential(github) ? { github } : {}), ...(values ? { mcp: values } : {}) } as Credentials;
  } catch {
    return {};
  }
}

/**
 * Replaces the whole file: the same atomic write (temp + rename) hive.config.json uses, with owner-only modes.
 * The temp name is unique and `wx` refuses to write through a file already sitting at that path (planted or a
 * symlink) instead of silently inheriting its mode or target on rename.
 */
export async function writeCredentials(next: Credentials, env?: NodeJS.ProcessEnv): Promise<void> {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
