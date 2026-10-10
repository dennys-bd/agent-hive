// The editor pane's change marks (#668), VS Code's quick diff: a bar beside each added or modified line and a triangle where lines were
// deleted, the buffer as it is now against its file's base (file-base.ts). A click on a mark opens the peek (change-peek.ts). Loaded with
// Monaco, which re-exports it (monaco.ts) and hands its namespace in.
import type { editor, IDisposable } from 'monaco-editor';
import { type ChangePeek, openPeek, type PeekMonaco } from '@/lib/change-peek';
import * as fileBase from '@/lib/file-base';
import { type LineChange, lineChanges } from '@/lib/line-changes';

const RECOMPUTE_MS = 300; // after the last edit: a recompute runs once typing pauses, not on every key; a large file's diff is capped by MAX_COMPUTATION_MS
const MARK_CLASS: Record<LineChange['kind'], string> = { add: 'hive-change-add', modify: 'hive-change-modify', delete: 'hive-change-delete' };

/** The file the marks compare (#668): its activity and path, the file-base store's key. */
export interface MarkedFile { activityId: string; path: string }

// The line a change's mark sits on: its first line; a deletion's is the line after it.
// ponytail: a deletion at the end of the file marks the top of the last line, not its foot; a class of its own if that ever misleads
const markLine = (change: LineChange, lineCount: number): number => Math.max(1, Math.min(change.start, lineCount));

function decorationOf(change: LineChange, lineCount: number): editor.IModelDeltaDecoration {
  const first = markLine(change, lineCount);
  const last = change.kind === 'delete' ? first : change.end - 1;
  return { range: { startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn: 1 }, options: { linesDecorationsClassName: MARK_CLASS[change.kind] } };
}

/** The change whose mark sits on `line` (#668); -1 for none. A deletion's triangle straddles the boundary into the line above, so a click
 * there opens it too, unless that line has a mark of its own, which comes first in the file's order. */
export const changeAt = (changes: readonly LineChange[], line: number, lineCount: number): number =>
  changes.findIndex((c) => (c.kind === 'delete' ? [line, line + 1].includes(markLine(c, lineCount)) : c.start <= line && line < c.end));

/** Marks the editor's gutter with its file's changes (#668): at once from the base held, 300 ms after the last edit, and whenever the base's
 * text moves. The base is asked here, and again on every version poll (EditorPane's useDiskWatch). Returns the detach, which the editor's end
 * runs too. */
export function attachGutterMarks(monaco: PeekMonaco, view: editor.IStandaloneCodeEditor, { activityId, path }: MarkedFile): () => void {
  const marks = view.createDecorationsCollection();
  let changes: LineChange[] = [];
  let shownBase: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let peek: ChangePeek | undefined;
  let ends: IDisposable | undefined;
  const lineCount = (): number => view.getModel()?.getLineCount() ?? 0;
  const recompute = (): void => {
    shownBase = fileBase.baseOf(activityId, path)?.text;
    const text = view.getModel()?.getValue();
    changes = shownBase === undefined || text === undefined ? [] : lineChanges(shownBase, text);
    marks.set(changes.map((change) => decorationOf(change, lineCount())));
    peek?.update(changes);
  };
  const stopBase = fileBase.subscribe(() => {
    if (fileBase.baseOf(activityId, path)?.text !== shownBase) recompute();
  });
  const edits = view.onDidChangeModelContent(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      recompute();
    }, RECOMPUTE_MS);
  });
  // A revert acts on the buffer as it is, not as it was before the last 300 ms of typing
  const flush = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    recompute();
  };
  const clicks = view.onMouseDown((event) => {
    const index = event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS ? changeAt(changes, event.target.position?.lineNumber ?? 0, lineCount()) : -1;
    if (index === -1 || shownBase === undefined) return;
    peek?.close();
    peek = openPeek(monaco, view, { changes, index, baseText: shownBase, flush }, () => { peek = undefined; });
  });
  const detach = (): void => {
    clearTimeout(timer);
    peek?.close();
    stopBase();
    for (const listener of [edits, clicks, ends]) listener?.dispose();
    marks.clear();
  };
  ends = view.onDidDispose(detach);
  recompute();
  void fileBase.refresh(activityId, path);
  return detach;
}
