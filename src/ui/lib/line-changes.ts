// A file's changes against its base as line ranges (#668): what the editor pane's gutter marks and its peek show. Monaco's own line diff, the
// algorithm VS Code's quick diff runs, computed on the page. Pure: no editor, no DOM.
import { DefaultLinesDiffComputer } from 'monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';

/** One change (#668), 1-based, ends exclusive. start..end: the buffer's lines; a deletion has start === end, the line the deleted lines stood
 * before (one past the last line at the end of the file). baseStart..baseEnd: the base's lines it replaced; an add has baseStart === baseEnd. */
export interface LineChange { kind: 'add' | 'modify' | 'delete'; start: number; end: number; baseStart: number; baseEnd: number }

const MAX_COMPUTATION_MS = 200; // past it the diff is an approximation: no marks beat wrong ones
const LINE_BREAK = /\r\n|\r|\n/;
const computer = new DefaultLinesDiffComputer();

const kindOf = (baseLines: number, lines: number): LineChange['kind'] => {
  if (baseLines === 0) return 'add';
  return lines === 0 ? 'delete' : 'modify';
};

/** The changes from `base` to `current` (#668), in order. An empty base makes the whole text added; a diff that hits the time limit gives none. */
export function lineChanges(base: string, current: string): LineChange[] {
  const lines = current.split(LINE_BREAK);
  if (base === '') return current === '' ? [] : [{ kind: 'add', start: 1, end: lines.length + 1, baseStart: 1, baseEnd: 1 }];
  const diff = computer.computeDiff(base.split(LINE_BREAK), lines, { ignoreTrimWhitespace: false, maxComputationTimeMs: MAX_COMPUTATION_MS, computeMoves: false });
  if (diff.hitTimeout) return [];
  return diff.changes.map(({ original, modified }) => ({
    kind: kindOf(original.endLineNumberExclusive - original.startLineNumber, modified.endLineNumberExclusive - modified.startLineNumber),
    start: modified.startLineNumber,
    end: modified.endLineNumberExclusive,
    baseStart: original.startLineNumber,
    baseEnd: original.endLineNumberExclusive,
  }));
}
