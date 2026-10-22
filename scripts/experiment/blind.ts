import { basename } from 'node:path';
import { assertBlind as assertBlindWith, type BundleFile, hasTell as hasTellIn, REDACTED, scrub as scrubWith, writeBundle } from '../../src/benchmark/blind.js';
import type { Click, Metrics } from './types.js';

export { type BundleFile, REDACTED, writeBundle };
/** The Hive plugin's subagents (assets/plugin/agents/*.md, *.md.liquid); a test keeps this in step. */
export const PLUGIN_SUBAGENTS = ['architect', 'build-fixer', 'code-reviewer', 'decomposition-reviewer', 'design-reviewer', 'designer', 'plan-reviewer', 'planner', 'security-reviewer', 'spec-reviewer', 'tdd', 'template-reviewer'] as const;
/** Every arm tell (#105, the user): both arms' commands and skills, their namespaces, the plugin's subagents. Namespaced forms first. */
export const TELLS: readonly RegExp[] = [
  /\/?\bhive:[\w-]+/gi,
  /\/?\b(?:hive|new)-(?:spec|plan|build|pr)\b/gi,
  /\bsuperpowers\b(?::[\w-]+)?/gi,
  /\becc:[\w-]+/gi,
  new RegExp(`\\b(?:${PLUGIN_SUBAGENTS.join('|')})\\b`, 'gi'),
];
export const ARM_LEAK = /-a-|-b-|arm|hive-spec|new-spec|hive-plan|new-plan|hive-build|new-build|hive-pr|new-pr/i;
const KEPT_SHOT = /^(?:S\d+-\d+|screen-4[a-z]\d?)\.png$/;

export const scrub = (text: string): string => scrubWith(text, TELLS);
export const hasTell = (text: string): boolean => hasTellIn(text, TELLS);

export interface BundleInput { handoffShots: string[]; runShots: string[]; clicks?: Click[]; docs: { kind: 'spec' | 'plan'; text: string }[]; diff: string; metrics: Metrics }

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const shotName = (path: string, i: number): string => `run/${KEPT_SHOT.test(basename(path)) ? basename(path) : `shot-${String(i + 1).padStart(2, '0')}.png`}`;

/** The numbers and the outcome only: no token, no reason, no flag, no cost (#473: an arm that differs by model would show in its price). */
export function blindMetrics(m: Metrics): Record<string, unknown> {
  return {
    outcome: m.outcome, tokens: m.tokens, ms: m.ms, waitingMs: m.waitingMs, restarts: m.restarts.count, diff: m.diff,
    tasks: m.tasks.map((t, i) => ({ task: i + 1, tokens: t.tokens, ms: t.ms, waitingMs: t.waitingMs, stages: t.stages, restarts: t.restarts })),
  };
}

const docFiles = (docs: BundleInput['docs']): BundleFile[] =>
  (['spec', 'plan'] as const).flatMap((kind) => docs.filter((d) => d.kind === kind).map((d, i) => ({ name: `docs/${kind}-${i + 1}.md`, text: scrub(d.text) })));

export function bundleFiles(input: BundleInput): BundleFile[] {
  const renamed = new Map(input.runShots.map((path, i) => [basename(path), shotName(path, i)]));
  const clicks = input.clicks?.map((c) => ({ ...c, notes: scrub(c.notes), screenshots: c.screenshots.map((s) => renamed.get(basename(s)) ?? 'run/missing.png') }));
  return [
    ...input.handoffShots.map((path) => ({ name: `handoff/${basename(path)}`, copyFrom: path })),
    ...input.runShots.map((path, i) => ({ name: shotName(path, i), copyFrom: path })),
    ...(clicks ? [{ name: 'clicks.json', text: json(clicks) }] : []),
    ...docFiles(input.docs),
    { name: 'diff.patch', text: scrub(input.diff) },
    { name: 'metrics.json', text: json(blindMetrics(input.metrics)) },
  ];
}

/** The harness's check (#105): its fixed name leaks first, then the shared check with its fixed tells; its arms have no letter to check. */
export function assertBlind(files: readonly BundleFile[]): void {
  const leak = files.find((f) => ARM_LEAK.test(f.name));
  if (leak) throw new Error(`the blind bundle would name the arm: ${leak.name}`);
  assertBlindWith(files, TELLS, []);
}
