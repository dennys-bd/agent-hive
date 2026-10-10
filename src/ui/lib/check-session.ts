// The page's command-line checkers (#782): after a save answers and when a file opens, one POST per checker of the file's language that is on in
// its workspace (on open, only one with no result yet for its target: the file for a file checker, the activity for a project one). The answers go
// to the diagnostics store and become the open models' markers, owned by `check:<id>`. A superseded answer is a newer run's business: ignored.
import type { editor } from 'monaco-editor';
import { checkerOn, type CliCheckerDef, cliCheckersFor } from '../../checkers';
import { otherExtensions } from '../../formatters';
import { languageOf } from '../../languages';
import { postJson } from '@/lib/api';
import * as store from '@/lib/diagnostics-store';
import type { CheckOutcome } from '@/lib/diagnostics-store';
import { loadMonaco } from '@/lib/editor-models';
import { enumsOf } from '@/lib/lsp-providers';
import type { CheckAnswer, CliCheckerId, EditorConfig } from '../../types';

export interface CheckInput { activityId: string; workspace: string; path: string; model: editor.ITextModel; editor: EditorConfig }

const attached = new Map<string, { input: CheckInput; defs: CliCheckerDef[] }>(); // activity + path → the pane's file and its checkers
const ANSWERS: readonly string[] = ['done', 'failed', 'absent', 'superseded'];
const isAnswer = (value: unknown): value is CheckAnswer =>
  typeof value === 'object' && value !== null && ANSWERS.includes(String((value as { state?: unknown }).state));
const targetOf = (def: CliCheckerDef, path: string): string => (def.scope === 'file' ? path : '');

/** The command-line checkers that run for a file in a workspace (#782): its language's that read it, on there. */
export function checkersFor(path: string, workspace: string, config: EditorConfig): CliCheckerDef[] {
  const language = languageOf(path, otherExtensions(config));
  return language === undefined ? [] : cliCheckersFor(language, path).filter((def) => checkerOn(config, language, def.id, workspace));
}

/** The ids of a file's checkers (#782), joined: what the pane keys its attach on. */
export const checksKey = (path: string, workspace: string, config: EditorConfig): string => checkersFor(path, workspace, config).map((def) => def.id).join(' ');

// The checker's problems as markers on every open model of the activity it runs for
async function paint(activityId: string, checker: CliCheckerId): Promise<void> {
  const open = [...attached.values()].filter(({ input, defs }) => input.activityId === activityId && defs.some((def) => def.id === checker));
  if (open.length === 0) return;
  const { monaco } = await loadMonaco();
  const { severity } = enumsOf(monaco);
  const level = { error: severity.Error, warning: severity.Warning, info: severity.Info };
  for (const { input } of open) {
    const list = store.checkProblems(activityId, checker, input.path).map((p) => ({
      startLineNumber: p.line, startColumn: p.column, endLineNumber: p.endLine ?? p.line, endColumn: p.endColumn ?? p.column, // Monaco widens an empty range to the word
      message: p.message, severity: level[p.severity], source: checker, ...(p.code === undefined ? {} : { code: p.code }),
    }));
    monaco.editor.setModelMarkers(input.model, `check:${checker}`, list);
  }
}

async function run(input: CheckInput, def: CliCheckerDef): Promise<void> {
  const { activityId, path } = input;
  const target = targetOf(def, path);
  store.checkStarted(activityId, def.id, target);
  const answer = await postJson<unknown>(`/activities/${encodeURIComponent(activityId)}/check/${def.id}`, { path }).then(
    (value): CheckAnswer | CheckOutcome => (isAnswer(value) ? value : { state: 'failed', reason: 'an answer that does not read' }),
    (err: unknown): CheckOutcome => ({ state: 'failed', reason: err instanceof Error ? err.message : String(err) }),
  );
  if (answer.state === 'superseded') return;
  store.setCheck(activityId, def.id, answer, target);
  await paint(activityId, def.id);
}

/** Runs a file's checkers for the pane that shows it (#782): each with no result yet for its target runs, the others paint what they have.
 * Returns the detach, which clears the file's check markers; a newer attach of the same file keeps its own. */
export function attachChecks(input: CheckInput): () => void {
  const defs = checkersFor(input.path, input.workspace, input.editor);
  const key = `${input.activityId}\0${input.path}`;
  attached.set(key, { input, defs });
  store.bindChecks(input.activityId, input.path, defs.map((def) => def.id));
  for (const def of defs) {
    if (store.hasCheck(input.activityId, def.id, targetOf(def, input.path))) void paint(input.activityId, def.id);
    else void run(input, def);
  }
  return () => {
    void loadMonaco().then(({ monaco }) => { for (const def of defs) monaco.editor.setModelMarkers(input.model, `check:${def.id}`, []); });
    if (attached.get(key)?.input !== input) return;
    attached.delete(key);
    store.unbindChecks(input.activityId, input.path);
  };
}

/** A save went through (#782): every checker of the file runs again, on the disk's text. */
export function notifyChecksSaved(activityId: string, path: string): void {
  const entry = attached.get(`${activityId}\0${path}`);
  if (entry !== undefined) for (const def of entry.defs) void run(entry.input, def);
}

/** Forgets every attached file (a test's reset). */
export function resetChecks(): void {
  attached.clear();
}
