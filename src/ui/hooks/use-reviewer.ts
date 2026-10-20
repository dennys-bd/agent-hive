// The template reviewer in the editor (#329): POST /api/items/:id/review on the open file when the `reviewer` setting says, the answer kept
// per file with the text of each annotated line, and the setting's write for the head's menu. One run at a time, as the route allows one per
// item; a run whose text the editor no longer shows is aborted and its answer dropped.
import { createContext, type Dispatch, type RefObject, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentAnnotation } from '../../reviewer';
import { REVIEWER_DEFAULTS, type ReviewerConfig, type SettingsResult } from '../../types';
import type { MessageKey } from '@/i18n';
import { postJson } from '@/lib/api';

export const REVIEW_PAUSE_MS = 2000; // as you type; a settings candidate ("Reviewer pause before reviewing")
const BUSY_RETRY_MS = 1000; // the server frees the item only once the run it cancelled has exited
const NOT_SAVED: MessageKey = 'plugins.reviewer.error.notSaved';
const RUN_FAILED: MessageKey = 'plugins.reviewer.error.runFailed';
// The route's ReviewCode (server-template-review.ts, which the page cannot import). busy and off show nothing: busy is the guard against a
// second run, off a setting turned off that the page has not reloaded yet
const COPY: Readonly<Record<string, MessageKey>> = {
  agent_unavailable: 'plugins.reviewer.error.agentUnavailable',
  reviewer_unavailable: 'plugins.reviewer.error.reviewerUnavailable',
  bad_answer: 'plugins.reviewer.error.badAnswer',
  run_failed: RUN_FAILED,
};
const SILENT: readonly string[] = ['busy', 'off'];
const SEVERITIES: readonly string[] = ['yellow', 'red'];
const NONE: readonly AgentAnnotation[] = [];

export interface Scope { id: string; version: string | null; path: string }
export const itemKeyOf = ({ id, version }: Pick<Scope, 'id' | 'version'>): string => `${id}\0${version ?? ''}`;
export const fileKeyOf = (scope: Scope): string => `${itemKeyOf(scope)}\0${scope.path}`;

/** What the head's menu reads and writes (#329). */
export interface Review {
  config: ReviewerConfig;
  running: boolean;
  error?: MessageKey; // the last failure's copy, by ReviewCode, or a setting not saved
  now(): void; // "review now"
  set(change: Partial<ReviewerConfig>): Promise<void>;
}
/** The `reviewer` setting as App provides it: the saved key and its write. */
export interface ReviewerSettings { config: ReviewerConfig; save(reviewer: ReviewerConfig): Promise<void> }

// Outside App (the tests' harness): on demand, so no editor test posts a review it did not ask for, and a write fails
export const ReviewerContext = createContext<ReviewerSettings>({
  config: { ...REVIEWER_DEFAULTS, when: 'demand' },
  save: () => Promise.reject(new Error('the reviewer setting is written only inside App')),
});

/** The write as the close-tab notices save one key (App.tsx): the prefix, which configFrom has no fallback for, and the key, then the
 * settings info reloaded so the menu reads what was saved. A refusal throws. */
export function reviewerSaver(prefix: string | undefined, reload: () => Promise<unknown>): ReviewerSettings['save'] {
  return async (reviewer) => {
    await postJson<SettingsResult>('/settings', { prefix, reviewer });
    await reload();
  };
}

interface Stored { annotation: AgentAnnotation; text: string } // text: its line's, as the agent read it
type Found = Readonly<Record<string, readonly Stored[]>>; // by fileKeyOf
interface Target { scope: Scope; file: string; text: string }
type Outcome = { annotations: AgentAnnotation[] } | { code?: string } | { aborted: true };
interface Latest { scope?: Scope; file?: string; text: string; saved?: string; config: ReviewerConfig }
interface Run { id: string; controller: AbortController }
// again: a trigger came during the run; aborted: the item of the last run this hook cancelled, which the server may still hold (busy)
interface Runs { run?: Run; again: boolean; aborted?: string; retry?: ReturnType<typeof setTimeout> }
interface Ctx {
  latest: RefObject<Latest>; runs: RefObject<Runs>;
  setFound: Dispatch<SetStateAction<Found>>; setRunning: Dispatch<SetStateAction<string | undefined>>; setError: Dispatch<SetStateAction<MessageKey | undefined>>;
}

const lineText = (lines: readonly string[], line: number): string => (lines[line - 1] ?? '').replace(/\r$/, '');
const reviewUrl = (id: string): string => `/api/items/${encodeURIComponent(id)}/review`;

function isAgentAnnotation(value: unknown): value is AgentAnnotation {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Partial<Record<keyof AgentAnnotation, unknown>>;
  return Number.isInteger(a.line) && SEVERITIES.includes(String(a.severity)) && typeof a.title === 'string' && typeof a.body === 'string' && a.source === 'agent';
}
// The route's answer checked at the boundary: another shape is a bad answer, as the route itself would call one
function annotationsOf(answer: unknown): AgentAnnotation[] | undefined {
  const list = typeof answer === 'object' && answer !== null ? (answer as { annotations?: unknown }).annotations : undefined;
  return Array.isArray(list) && list.every(isAgentAnnotation) ? list : undefined;
}

function nearest(lines: readonly string[], from: number, text: string): number | undefined {
  let best: number | undefined;
  for (let line = 1; line <= lines.length; line += 1) {
    if (lineText(lines, line) === text && (best === undefined || Math.abs(line - from) < Math.abs(best - from))) best = line;
  }
  return best;
}
// Each annotation on its own line while that line still reads as the agent read it, else on the nearest line that does, else gone: the agent
// read a text that no longer holds
// ponytail: a line repeated elsewhere (a blank, a fence) can take an annotation whose own line changed; a line diff if that ever misleads
function placed(stored: readonly Stored[], lines: readonly string[]): AgentAnnotation[] {
  return stored.flatMap(({ annotation, text }) => {
    if (lineText(lines, annotation.line) === text) return [annotation];
    const line = nearest(lines, annotation.line, text);
    return line === undefined ? [] : [{ ...annotation, line }];
  });
}

async function request({ scope, text }: Target, signal: AbortSignal): Promise<Outcome> {
  try {
    const answer = await postJson<unknown>(reviewUrl(scope.id), { version: scope.version, path: scope.path, text }, { signal });
    const annotations = annotationsOf(answer);
    if (annotations === undefined) console.error(`reviewer: the review of ${scope.id} answered an unexpected shape`, answer);
    return annotations === undefined ? { code: 'bad_answer' } : { annotations };
  } catch (err) {
    if (signal.aborted) return { aborted: true };
    const { code } = err as { code?: unknown };
    if (typeof code !== 'string' || !SILENT.includes(code)) console.error(`reviewer: the review of ${scope.id} failed`, err);
    return typeof code === 'string' ? { code } : {};
  }
}

function start(ctx: Ctx, target: Target, isRetry = false): void {
  const controller = new AbortController();
  ctx.runs.current = { ...ctx.runs.current, run: { id: target.scope.id, controller }, again: false };
  ctx.setRunning(target.file);
  void request(target, controller.signal).then((outcome) => settle(ctx, target, controller, outcome, isRetry));
}

function keep(ctx: Ctx, { file, text }: Target, annotations: readonly AgentAnnotation[]): void {
  const lines = text.split('\n');
  ctx.runs.current = { ...ctx.runs.current, aborted: undefined };
  ctx.setFound((last) => ({ ...last, [file]: annotations.map((annotation) => ({ annotation, text: lineText(lines, annotation.line) })) }));
  ctx.setError(undefined);
}

function retryLater(ctx: Ctx, target: Target): void {
  const retry = setTimeout(() => {
    ctx.runs.current = { ...ctx.runs.current, retry: undefined };
    if (ctx.runs.current.run === undefined) start(ctx, target, true);
  }, BUSY_RETRY_MS);
  ctx.runs.current = { ...ctx.runs.current, aborted: undefined, retry };
}

// A trigger that came during the run: one more, of the text the setting reviews now, if it moved on from the one just reviewed
function runAgain(ctx: Ctx, reviewed: Target): void {
  const now = ctx.latest.current;
  const text = now.config.when === 'save' ? now.saved : now.text;
  if (now.scope === undefined || now.file !== reviewed.file || text === undefined || text === reviewed.text) return;
  start(ctx, { scope: now.scope, file: now.file, text });
}

// The answer of the current run only: an aborted run's answer is for a text no longer shown
function settle(ctx: Ctx, target: Target, controller: AbortController, outcome: Outcome, isRetry: boolean): void {
  const runs = ctx.runs.current;
  if (runs.run?.controller !== controller) return;
  ctx.runs.current = { ...runs, run: undefined, again: false };
  ctx.setRunning(undefined);
  if ('aborted' in outcome) return;
  const code = 'code' in outcome ? outcome.code : undefined;
  if (code === 'busy' && !isRetry && runs.aborted === target.scope.id) {
    retryLater(ctx, target);
    return;
  }
  if ('annotations' in outcome) keep(ctx, target, outcome.annotations);
  else if (!SILENT.includes(code ?? '')) ctx.setError(COPY[code ?? ''] ?? RUN_FAILED);
  if (runs.again) runAgain(ctx, target);
}

function trigger(ctx: Ctx, text: string): void {
  const { scope, file, config } = ctx.latest.current;
  if (scope === undefined || file === undefined || !config.on) return;
  if (ctx.runs.current.run !== undefined) ctx.runs.current = { ...ctx.runs.current, again: true };
  else start(ctx, { scope, file, text });
}

function abort(ctx: Ctx): void {
  const { run, retry, aborted } = ctx.runs.current;
  if (retry !== undefined) clearTimeout(retry);
  run?.controller.abort(); // the route cancels the agent's run when the client goes away (#328)
  ctx.runs.current = { again: false, aborted: run?.id ?? aborted };
  ctx.setRunning(undefined);
}

// Each trigger fires on a change within one file: opening a file, or another version of it, is not a change
function useSaveTrigger(ctx: Ctx, file: string | undefined, saved: string | undefined, isOn: boolean): void {
  const seen = useRef<{ file?: string; saved?: string }>({});
  useEffect(() => {
    const last = seen.current;
    seen.current = { file, saved };
    if (!isOn || file === undefined || saved === undefined || last.file !== file || last.saved === undefined || last.saved === saved) return;
    trigger(ctx, saved);
  }, [ctx, file, saved, isOn]);
}

function useTypeTrigger(ctx: Ctx, file: string | undefined, text: string, isOn: boolean): void {
  const seen = useRef<{ file?: string; text?: string }>({});
  useEffect(() => {
    const last = seen.current;
    seen.current = { file, text };
    if (!isOn || file === undefined || last.file !== file || last.text === text) return undefined;
    const timer = setTimeout(() => trigger(ctx, text), REVIEW_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [ctx, file, text, isOn]);
}

/** The open file's agent annotations and the menu's review (#329). `saved` is the open file's saved text, `text` its buffer. */
export function useReviewer(scope: Scope | undefined, text: string, saved: string | undefined, config: ReviewerConfig, save: ReviewerSettings['save']): { list: readonly AgentAnnotation[]; review: Review } {
  const [found, setFound] = useState<Found>({});
  const [running, setRunning] = useState<string>(); // the file whose run is going
  const [error, setError] = useState<MessageKey>();
  const latest = useRef<Latest>({ text, config });
  const runs = useRef<Runs>({ again: false });
  const [ctx] = useState<Ctx>(() => ({ latest, runs, setFound, setRunning, setError }));
  const file = scope && fileKeyOf(scope);
  useEffect(() => { latest.current = { scope, file, text, saved, config }; }); // first: the triggers below read it
  // biome-ignore lint/correctness/useExhaustiveDependencies: file and config.on are the triggers of the cleanup (abort the run), not values it uses
  useEffect(() => () => abort(ctx),[ctx, file, config.on]);
  useSaveTrigger(ctx, file, saved, config.on && config.when === 'save');
  useTypeTrigger(ctx, file, text, config.on && config.when === 'type');
  const lines = useMemo(() => text.split('\n'), [text]);
  const stored = file === undefined ? undefined : found[file];
  const list = useMemo(() => (stored === undefined || !config.on ? NONE : placed(stored, lines)), [stored, lines, config.on]);
  const set = async (change: Partial<ReviewerConfig>): Promise<void> => {
    const next = { ...config, ...change };
    try {
      await save(next);
      setError((last) => (!next.on || last === NOT_SAVED ? undefined : last));
    } catch (err) {
      console.error('reviewer: the setting was not saved', err);
      setError(NOT_SAVED);
    }
  };
  return { list, review: { config, running: file !== undefined && running === file, error, now: () => trigger(ctx, text), set } };
}
