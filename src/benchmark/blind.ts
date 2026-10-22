// What the blind judge may read (#105, #474), moved from the harness: the tells come from the experiment, not from a fixed list.
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { deliveredName } from '../template.js';
import type { ArmSetup, BenchMetrics, BenchScenario, CollectorResult, Experiment, ScenarioResult } from '../types.js';
import type { Click } from './browser.js';

export const REDACTED = '[redacted]';
export interface BundleFile { name: string; copyFrom?: string; text?: string }

const escapeWord = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A tell is a whole word: `plan` must not scrub `plans`, nor `new-plan` match inside `renew-plan`
const wordPattern = (word: string): RegExp => new RegExp(`/?(?<![\\w-])${escapeWord(word)}(?![\\w-])`, 'gi');

export const scrub = (text: string, tells: readonly RegExp[]): string => tells.reduce((acc, pattern) => acc.replace(pattern, REDACTED), text);
export const hasTell = (text: string, tells: readonly RegExp[]): boolean => tells.some((pattern) => new RegExp(pattern.source, 'i').test(text));

const skillWords = (skill: string): string[] => {
  const bare = skill.replace(/^\//, '');
  const colon = bare.indexOf(':');
  return colon < 0 ? [bare] : [bare, bare.slice(colon + 1)];
};

/** Every tell of one experiment (#474): what tells its arms apart. Never an arm letter: one character would scrub every `A` of a diff. */
export function blindTells(experiment: Experiment, subagents: readonly string[]): RegExp[] {
  const setups: Partial<ArmSetup>[] = [experiment.base, ...experiment.arms.map((a) => a.overrides)];
  const words = [
    ...experiment.arms.map((a) => a.name),
    ...setups.flatMap((s) => Object.values(s.stages ?? {}).flatMap((pick) => skillWords(pick.skill))),
    ...setups.flatMap((s) => s.plugins ?? []).map((path) => basename(path)),
    ...subagents, ...experiment.blindness.forbiddenWords,
  ].map((w) => w.trim()).filter((w) => w !== '');
  return [...new Set(words)].sort((a, b) => b.length - a.length).map(wordPattern);
}

export async function pluginSubagents(pluginDir: string): Promise<string[]> {
  const files = await readdir(join(pluginDir, 'agents')).catch((): string[] => []);
  return files.map(deliveredName).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)).sort();
}

export interface BundleInput { patch: string; metrics?: BenchMetrics; collectors: readonly CollectorResult[]; scenarios: readonly BenchScenario[]; results: readonly ScenarioResult[]; walks: readonly Click[][]; screens: string }

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

// The task keys carry the run's token: each becomes task-N, longest key first so one key never eats part of another
const blindMetrics = (m: BenchMetrics): string =>
  m.tasks.map((t, i) => [t.key, `task-${i + 1}`] as const).sort(([a], [b]) => b.length - a.length)
    .reduce((text, [key, alias]) => text.replaceAll(key, alias), json(m));

const scenarioFile = (input: BundleInput): unknown[] =>
  input.scenarios.map((s) => {
    const result = input.results.find((r) => r.id === s.id);
    return { id: s.id, title: s.title, passed: result?.passed ?? 0, total: result?.total ?? input.walks.length, notes: input.walks.flatMap((walk) => walk.filter((c) => c.scenario === s.id).map((c) => c.notes)) };
  });

const shotFiles = (input: BundleInput): BundleFile[] =>
  input.walks.flatMap((walk, w) => walk.flatMap((click) => click.screenshots.map((shot, i) => ({
    name: `screens/${click.scenario.replace(/[^A-Za-z0-9_-]/g, '')}-${w + 1}-${i + 1}.png`, copyFrom: join(input.screens, shot),
  }))));

/** The judge's whole world (#474): the patch, the numbers, the findings and the walks, scrubbed and renamed so nothing names a collector, a task or an arm. */
export function bundleFiles(input: BundleInput, tells: readonly RegExp[]): BundleFile[] {
  const clean = (text: string): string => scrub(text, tells);
  const findings = input.collectors.map((c, i) => ({ collector: `collector-${i + 1}`, status: c.status, findings: c.findings }));
  return [
    { name: 'diff.patch', text: clean(input.patch) },
    { name: 'metrics.json', text: clean(input.metrics === undefined ? json(null) : blindMetrics(input.metrics)) },
    { name: 'findings.json', text: clean(json(findings)) },
    { name: 'scenarios.json', text: clean(json(scenarioFile(input))) },
    ...shotFiles(input),
  ];
}

const letterIn = (letter: string): RegExp => new RegExp(`(?:^|[^a-z0-9])${escapeWord(letter)}(?:[^a-z0-9]|$)`, 'i');

export function assertBlind(files: readonly BundleFile[], tells: readonly RegExp[], letters: readonly string[]): void {
  const leak = files.find((f) => letters.some((l) => letterIn(l).test(f.name)) || hasTell(f.name, tells) || hasTell(f.text ?? '', tells));
  if (leak) throw new Error(`the blind bundle would name the arm: ${leak.name}`);
}

export async function writeBundle(dir: string, files: readonly BundleFile[]): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  for (const file of files) {
    const path = join(dir, file.name);
    await mkdir(dirname(path), { recursive: true });
    if (file.copyFrom !== undefined) await copyFile(file.copyFrom, path);
    else await writeFile(path, file.text ?? '');
  }
}
