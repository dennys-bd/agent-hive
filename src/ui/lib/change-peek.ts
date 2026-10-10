// The peek under a change (#668), VS Code's quick diff peek: the change as an inline diff, its base lines over its lines now, under a row with
// its place among the file's changes, reverter este trecho, previous, next and close. Plain DOM in an overlay widget kept over an empty view
// zone, as VS Code's ZoneWidget does. Esc closes it; gutter-marks.ts closes it when an edit removes its change or the editor ends.
import type * as Monaco from 'monaco-editor';
import type { editor, IDisposable, IRange } from 'monaco-editor';
import { t } from '@/i18n';
import type { LineChange } from '@/lib/line-changes';

/** What the marks and the peek use of Monaco's namespace (#668): handed in, since the namespace loads with the first file opened (monaco.ts). */
export interface PeekMonaco { editor: Pick<typeof Monaco.editor, 'MouseTargetType' | 'EditorOption'> }

/** One change's peek (#668). update: the file's changes after an edit; the peek follows its change, or closes once the edit removed it. */
export interface ChangePeek { update(changes: readonly LineChange[]): void; close(): void }

/** What the peek opens on (#668): the file's changes, the one peeked, and the base's text they were computed against. flush: brings the changes
 * up to date with the buffer (through update) before a revert. */
export interface PeekInput { changes: readonly LineChange[]; index: number; baseText: string; flush?(): void }

const LINE_BREAK = /\r\n|\r|\n/;
const MAX_PEEK_LINES = 12; // a longer change scrolls inside the peek
const ROW_LINES = 2; // the row and its borders, in editor lines
const BUTTON = 'rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground';

interface Shown { zoneId: string; widget: editor.IOverlayWidget; layout: IDisposable }
interface Actions { revert(): void; prev(): void; next(): void; close(): void }

const rangeOf = ([startLineNumber, startColumn]: [number, number], [endLineNumber, endColumn]: [number, number]): IRange =>
  ({ startLineNumber, startColumn, endLineNumber, endColumn });

/** What reverting a change writes (#668): its lines in the buffer replaced by the base's, line breaks included, so a change at the end of the
 * file leaves no stray break and a deletion there comes back after one. maxColumn: the model's getLineMaxColumn. */
export function revertEdit(change: LineChange, baseLines: readonly string[], lineCount: number, maxColumn: (line: number) => number, eol: string): { range: IRange; text: string } {
  const lines = baseLines.slice(change.baseStart - 1, change.baseEnd - 1);
  const end: [number, number] = [lineCount, maxColumn(lineCount)];
  if (change.end <= lineCount) return { range: rangeOf([change.start, 1], [change.end, 1]), text: lines.map((line) => `${line}${eol}`).join('') };
  if (change.start > lineCount) return { range: rangeOf(end, end), text: `${eol}${lines.join(eol)}` };
  if (lines.length > 0 || change.start === 1) return { range: rangeOf([change.start, 1], end), text: lines.join(eol) };
  return { range: rangeOf([change.start - 1, maxColumn(change.start - 1)], end), text: '' };
}

// A change's identity across edits: its kind and base lines, which an edit elsewhere in the buffer never moves
const sameChange = (a: LineChange, b: LineChange): boolean => a.kind === b.kind && a.baseStart === b.baseStart && a.baseEnd === b.baseEnd;
// The line the zone goes under: the change's last line, a deletion's line before it (0: the top of the file)
const zoneAfter = (change: LineChange): number => (change.kind === 'delete' ? change.start - 1 : change.end - 1);

function button(label: string, text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = BUTTON;
  element.textContent = text;
  element.title = label;
  element.setAttribute('aria-label', label);
  element.addEventListener('click', onClick);
  return element;
}

interface LineFont { fontFamily: string; lineHeight: number }
// The diff's lines the zone shows at once; a longer change scrolls
const shownLines = (baseLines: readonly string[], lines: readonly string[]): number => Math.max(1, Math.min(baseLines.length + lines.length, MAX_PEEK_LINES));

// One line of the peek's diff: the sign and the text, on the diff pane's 12% body tint (DiffLines.tsx), in the editor's font
function diffLine(sign: '-' | '+', text: string, height: string, fontFamily: string): HTMLDivElement {
  const line = document.createElement('div');
  line.className = `whitespace-pre px-2 ${sign === '-' ? 'bg-destructive/12' : 'bg-working/12'}`;
  Object.assign(line.style, { height, lineHeight: height, fontFamily });
  line.textContent = `${sign} ${text}`;
  return line;
}

// The zone's DOM: the row, then the change as an inline diff, VS Code's peek: its base lines in red over its lines now in green. Plain lines,
// not a nested editor: Monaco inside a view zone measured and painted itself cut. Heights in the editor's own line height, in px: a
// percentage of the zone left the lines overlapping
function zoneNode(place: string, actions: Actions, baseLines: readonly string[], lines: readonly string[], { fontFamily, lineHeight }: LineFont): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'flex flex-col border-y bg-card text-xs';
  const row = document.createElement('div');
  row.className = 'flex shrink-0 items-center gap-1 px-2 text-muted-foreground';
  row.style.height = `${ROW_LINES * lineHeight}px`;
  const placeText = document.createElement('span');
  placeText.className = 'mr-2';
  placeText.textContent = place;
  const revert = button(t('changes.revert'), t('changes.revert'), actions.revert);
  row.append(placeText, revert, button(t('changes.prev'), '↑', actions.prev), button(t('changes.next'), '↓', actions.next), button(t('changes.close'), '×', actions.close));
  const diff = document.createElement('div');
  diff.className = 'overflow-auto';
  diff.style.height = `${shownLines(baseLines, lines) * lineHeight}px`;
  const height = `${lineHeight}px`;
  diff.append(...baseLines.map((text) => diffLine('-', text, height, fontFamily)), ...lines.map((text) => diffLine('+', text, height, fontFamily)));
  node.append(row, diff);
  return node;
}

// The zone under `change`, its row and its base lines
function showZone(view: editor.IStandaloneCodeEditor, font: LineFont, change: LineChange, baseLines: readonly string[], place: string, actions: Actions): Shown {
  const model = view.getModel();
  const lines = model === null ? [] : Array.from({ length: change.end - change.start }, (_, i) => model.getLineContent(change.start + i));
  const node = zoneNode(place, actions, baseLines, lines, font);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') actions.close();
  });
  // VS Code's ZoneWidget: an empty view zone opens the room between the lines, and the peek is an overlay widget kept over it. Monaco takes
  // the pointer of anything inside a view zone, so buttons there never got a click; an overlay widget's, as the find widget's, are its own
  node.style.position = 'absolute';
  const alignToContent = (): void => {
    const { contentLeft, contentWidth, verticalScrollbarWidth } = view.getLayoutInfo();
    Object.assign(node.style, { left: `${contentLeft}px`, width: `${contentWidth - verticalScrollbarWidth}px` });
  };
  alignToContent();
  const widget: editor.IOverlayWidget = { getId: () => `hive.changePeek.${change.start}`, getDomNode: () => node, getPosition: () => null };
  view.addOverlayWidget(widget);
  let zoneId = '';
  view.changeViewZones((accessor) => {
    zoneId = accessor.addZone({
      afterLineNumber: zoneAfter(change), heightInLines: shownLines(baseLines, lines) + ROW_LINES, domNode: document.createElement('div'),
      onDomNodeTop: (top) => { node.style.top = `${top}px`; }, onComputedHeight: (height) => { node.style.height = `${height}px`; },
    });
  });
  return { zoneId, widget, layout: view.onDidLayoutChange(alignToContent) };
}

function hideZone(view: editor.IStandaloneCodeEditor, { zoneId, widget, layout }: Shown): void {
  view.changeViewZones((accessor) => accessor.removeZone(zoneId));
  view.removeOverlayWidget(widget);
  layout.dispose();
}

/** Opens the peek on `input.changes[input.index]` (#668), under its change. onClose runs once, whichever way it closes. */
export function openPeek(monaco: PeekMonaco, view: editor.IStandaloneCodeEditor, input: PeekInput, onClose: () => void): ChangePeek {
  const baseLines = input.baseText.split(LINE_BREAK);
  const font = { fontFamily: view.getRawOptions().fontFamily ?? '', lineHeight: view.getOption(monaco.editor.EditorOption.lineHeight) };
  let changes = input.changes;
  let index = input.index;
  let shown: Shown | undefined;
  let keys: IDisposable | undefined;
  const close = (): void => {
    if (shown === undefined) return;
    hideZone(view, shown);
    shown = undefined;
    keys?.dispose();
    onClose();
  };
  const revert = (): void => {
    input.flush?.();
    const model = view.getModel();
    if (model === null || shown === undefined) return; // the flush may have closed the peek: its change is gone
    model.pushEditOperations([], [revertEdit(changes[index], baseLines, model.getLineCount(), (line) => model.getLineMaxColumn(line), model.getEOL())], () => null);
    close();
  };
  const show = (at: number): void => {
    if (shown !== undefined) hideZone(view, shown);
    index = (at + changes.length) % changes.length;
    const change = changes[index];
    const place = t('changes.position', { n: index + 1, total: changes.length });
    shown = showZone(view, font, change, baseLines.slice(change.baseStart - 1, change.baseEnd - 1), place, { revert, prev: () => show(index - 1), next: () => show(index + 1), close });
  };
  keys = view.onKeyDown((event) => {
    if (event.browserEvent.key === 'Escape') close();
  });
  show(index);
  const update = (next: readonly LineChange[]): void => {
    const at = next.findIndex((change) => sameChange(change, changes[index]));
    if (at === -1) {
      close();
      return;
    }
    const isMoved = next.length !== changes.length || JSON.stringify(next[at]) !== JSON.stringify(changes[index]);
    changes = next;
    index = at;
    if (isMoved) show(at);
  };
  return { update, close };
}
