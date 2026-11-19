// The plugin author's changelog (#492): assets/plugin/changelog.yaml, by plugin version, then item id, then heading, one line each. The update
// screen shows a change's note in place of its counts. A file that does not read as that shape logs once and gives no notes: a note is a
// nicety, so it never fails the preview.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Logger } from './log.js';

export const CHANGELOG_FILE = 'changelog.yaml';
const SCHEMA = z.record(z.string(), z.record(z.string(), z.record(z.string(), z.string())));
export type Changelog = z.infer<typeof SCHEMA>;

// ponytail: x.y.z only, as plugin.json's version is written; a pre-release key never matches. A semver parser if the plugin ever ships one
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const partsOf = (version: string): number[] | undefined => VERSION.exec(version)?.slice(1).map(Number);
const compare = (a: readonly number[], b: readonly number[]): number => a.reduce((found, part, i) => found || part - (b[i] ?? 0), 0);

export async function readChangelog(pluginSource: string, log: Pick<Logger, 'warn'>): Promise<Changelog> {
  const path = join(pluginSource, CHANGELOG_FILE);
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return {}; // no changelog: the rows show their counts, as before #492
  try {
    const checked = SCHEMA.safeParse(parse(text) ?? {});
    if (checked.success) return checked.data;
    log.warn(`plugin changelog: ${path}: ${checked.error.issues[0]?.path.join('.') || 'root'}: ${checked.error.issues[0]?.message ?? 'invalid'}`);
  } catch (err) {
    log.warn(`plugin changelog: ${path}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  return {};
}

/** The note an update from `from` to `to` shows for one item's heading: the newest version in (from, to] that has one. */
export function noteFor(changelog: Changelog, itemId: string, heading: string, from: string, to: string): string | undefined {
  const [low, high] = [partsOf(from), partsOf(to)];
  if (low === undefined || high === undefined) return undefined;
  return Object.keys(changelog)
    .flatMap((version): [number[], string][] => {
      const parts = partsOf(version);
      return parts !== undefined && compare(parts, low) > 0 && compare(parts, high) <= 0 ? [[parts, version]] : [];
    })
    .sort(([a], [b]) => compare(b, a))
    .map(([, version]) => changelog[version]?.[itemId]?.[heading])
    .find((note) => note !== undefined);
}
