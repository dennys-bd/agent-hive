// The custom store's names and version.json (#315): pure checks, the refusal shape, and one atomic write. Every other I/O is the
// catalogue's and the store's.
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ItemKind } from './types.js';

const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const ORIGINAL = 'original'; // `from` of a version taken from the origin's files; so never a version's own name
export const VERSION_FILE = 'version.json';
export const FILES_DIR = 'files';
export const BASE_DIR = 'base';
export const NAME_MESSAGE = 'a name is lowercase letters, digits and dashes, starting with a letter or a digit';
export const PATH_MESSAGE = 'a file path is relative, with no .. and no leading /';

export type RefusalCode = 'bad_name' | 'bad_path' | 'unknown_item' | 'unknown_version' | 'unknown_workspace' | 'exists' | 'name_taken' | 'original_locked';
export interface StoreRefusal {
  code: RefusalCode;
  message: string;
}
export const refusal = (code: RefusalCode, message: string): StoreRefusal => ({ code, message });
export const isRefusal = (value: object): value is StoreRefusal => 'code' in value;

export const isName = (value: unknown): value is string => typeof value === 'string' && NAME.test(value);
export const isVersionName = (value: unknown): value is string => isName(value) && value !== ORIGINAL;

/** A path inside a version's files/: answered as given when every segment is a real name; undefined for anything that could leave it. */
export function safeFilePath(path: unknown): string | undefined {
  if (typeof path !== 'string' || path.includes('\\') || path.includes('\0')) return undefined;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? path : undefined;
}

/** The file Claude Code reads first: SKILL.md of a skill folder, <name>.md of a specialist; .liquid when it is a template (#310). */
export const mainFiles = (kind: ItemKind, name: string): string[] => (kind === 'skill' ? ['SKILL.md', 'SKILL.md.liquid'] : [`${name}.md`, `${name}.md.liquid`]);

export interface VersionJson {
  name: string;
  from: string | null;
  workspaces: string[];
  hiveVersion?: string;
}

const VERSION_JSON = z.object({ name: z.string().regex(NAME), from: z.string().nullable(), workspaces: z.array(z.string()), hiveVersion: z.string().optional() });

/** The version.json of the folder `folder`. Throws an Error naming the version, which the catalogue shows on the item instead of failing. */
export function parseVersionJson(text: string, folder: string): VersionJson {
  const fail = (why: string): never => {
    throw new Error(`version ${folder}: ${why}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('version.json is not JSON');
  }
  const parsed = VERSION_JSON.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(`version.json ${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
  }
  if (parsed.data.name !== folder) fail(`version.json names ${parsed.data.name}`);
  return parsed.data;
}

/** Temp + rename: a reader never sees half a version.json. */
export async function writeVersionJson(dir: string, version: VersionJson): Promise<void> {
  const path = join(dir, VERSION_FILE);
  await writeFile(`${path}.tmp`, `${JSON.stringify(version, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
