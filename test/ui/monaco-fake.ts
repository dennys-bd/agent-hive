// A Monaco for jsdom (#717): the models and the editor editor-models.ts and EditorPane.tsx touch, nothing drawn. A test file mocks the setup
// module with it: vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule)
import { attachGutterMarks } from '@/lib/gutter-marks';
type Listener = () => void;
interface Position { lineNumber: number; column: number }
/** A view zone as the peek adds it (#668): appended to the editor's host while it stands, so a test can query it. */
export interface FakeZone { afterLineNumber: number; heightInLines?: number; domNode: HTMLElement }
type KeyListener = (event: { browserEvent: KeyboardEvent }) => void;
const LINE_BREAK = /\r\n|\r|\n/;
let zoneCount = 0;
const GUTTER_LINE_DECORATIONS = 4; // monaco.editor.MouseTargetType's
/** A decoration as the marks set it (#668). */
export interface FakeDecoration { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; options: { linesDecorationsClassName?: string; className?: string; inlineClassName?: string; isWholeLine?: boolean } }
type MouseListener = (event: { target: { type: number; position: Position | null } }) => void;
/** A selection as Monaco's cursor event carries it (#331). */
export interface FakeSelection { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
type SelectionListener = (event: { selection: FakeSelection }) => void;

export const registered: { kind: string; language: string; provider: unknown }[] = [];
export const markers: { model: FakeModel; owner: string; list: unknown[] }[] = [];
const register = (kind: string) => (language: string, provider: unknown) => { registered.push({ kind, language, provider }); return { dispose: () => undefined }; };

export class FakeModel {
  static all: FakeModel[] = [];
  language: string;
  readonly uri = { toString: () => `inmemory://model/${FakeModel.all.length}` };
  disposed = false;
  private value: string;
  private readonly hasBom: boolean; // Monaco keeps a leading BOM apart from the text and returns it only on getValue(eol, true)
  private versionId = 1;
  private listeners: Listener[] = [];

  constructor(text: string, language: string) {
    this.hasBom = text.startsWith('\uFEFF');
    this.value = this.hasBom ? text.slice(1) : text;
    this.language = language;
    FakeModel.all.push(this);
  }

  getValue(_eol?: unknown, preserveBom = false): string { return preserveBom && this.hasBom ? `\uFEFF${this.value}` : this.value; }
  getLanguageId(): string { return this.language; }
  getWordUntilPosition(): { startColumn: number; endColumn: number } { return { startColumn: 1, endColumn: 1 }; }
  getAlternativeVersionId(): number { return this.versionId; }
  getFullModelRange(): { startLineNumber: number } { return { startLineNumber: 1 }; }
  getLineCount(): number { return this.value.split(LINE_BREAK).length; }
  getLineContent(line: number): string { return this.value.split(LINE_BREAK)[line - 1] ?? ''; }
  getLineMaxColumn(line: number): number { return (this.value.split(LINE_BREAK)[line - 1] ?? '').length + 1; }
  getEOL(): string { return '\n'; }
  pushEditOperations(_before: unknown, edits: { text: string }[]): null {
    this.set(edits[0].text);
    return null;
  }
  onDidChangeContent(listener: Listener): { dispose(): void } {
    this.listeners = [...this.listeners, listener];
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  }
  dispose(): void { this.disposed = true; }
  /** What typing in the editor does: new text, a new version id. */
  type(text: string): void { this.set(text); }
  setValue(text: string): void { this.set(text); }

  private set(text: string): void {
    this.value = text;
    this.versionId += 1;
    for (const listener of this.listeners) listener();
  }
}

// Monaco's EditorOption.lineHeight, and the line height the fake editor answers for it
const LINE_HEIGHT_OPTION = 75;
export const FAKE_LINE_HEIGHT = 18;

export class FakeEditor {
  static all: FakeEditor[] = [];
  readonly host: HTMLElement;
  readonly model: FakeModel;
  readonly onSave: () => void;
  readonly onSaveUnformatted: () => void;
  fontFamily: string;
  position?: Position;
  disposed = false;
  private zones = new Map<string, FakeZone>();
  private keys: KeyListener[] = [];
  private ends: Listener[] = [];
  decorations: FakeDecoration[] = [];
  private mouse: MouseListener[] = [];
  private selecting: SelectionListener[] = [];
  hiddenAreas: { startLineNumber: number; endLineNumber: number }[] = [];
  readOnly = false;

  constructor(host: HTMLElement, model: FakeModel, onSave: () => void, fontFamily: string, onSaveUnformatted: () => void = () => undefined) {
    this.host = host;
    this.model = model;
    this.onSave = onSave;
    this.onSaveUnformatted = onSaveUnformatted;
    this.fontFamily = fontFamily;
    FakeEditor.all.push(this);
  }

  saveViewState(): { scrollTop: number } { return { scrollTop: 40 }; }
  restoreViewState(_state: unknown): void {}
  setPosition(position: Position): void { this.position = position; }
  revealPositionInCenter(_position: Position): void {}
  focus(): void {}
  updateOptions({ fontFamily, readOnly }: { fontFamily?: string; readOnly?: boolean }): void { if (fontFamily !== undefined) this.fontFamily = fontFamily; if (readOnly !== undefined) this.readOnly = readOnly; }
  setHiddenAreas(ranges: { startLineNumber: number; endLineNumber: number }[]): void { this.hiddenAreas = ranges.map(({ startLineNumber, endLineNumber }) => ({ startLineNumber, endLineNumber })); }
  revealLineInCenter(_line: number): void {}
  getTopForLineNumber(line: number): number { return (line - 1) * FAKE_LINE_HEIGHT; }
  getScrollTop(): number { return 0; }
  onDidScrollChange(_listener: unknown): { dispose(): void } { return { dispose: () => undefined }; }
  getModel(): FakeModel { return this.model; }
  getRawOptions(): { fontFamily: string } { return { fontFamily: this.fontFamily }; }
  getOption(id: number): number | undefined { return id === LINE_HEIGHT_OPTION ? FAKE_LINE_HEIGHT : undefined; }
  createDecorationsCollection(): { set(list: FakeDecoration[]): void; clear(): void } {
    return { set: (list) => { this.decorations = list; }, clear: () => { this.decorations = []; } };
  }
  onDidChangeModelContent(listener: Listener): { dispose(): void } { return this.model.onDidChangeContent(listener); }
  onMouseDown(listener: MouseListener): { dispose(): void } {
    this.mouse = [...this.mouse, listener];
    return { dispose: () => { this.mouse = this.mouse.filter((l) => l !== listener); } };
  }
  onDidChangeCursorSelection(listener: SelectionListener): { dispose(): void } {
    this.selecting = [...this.selecting, listener];
    return { dispose: () => { this.selecting = this.selecting.filter((l) => l !== listener); } };
  }
  /** What selecting text in the editor does (#331). */
  select(selection: FakeSelection): void {
    for (const listener of this.selecting) listener({ selection });
  }
  /** What a click on the gutter's mark column at `line` does. */
  clickGutter(line: number): void {
    for (const listener of this.mouse) listener({ target: { type: GUTTER_LINE_DECORATIONS, position: { lineNumber: line, column: 1 } } });
  }
  changeViewZones(change: (accessor: { addZone(zone: FakeZone): string; removeZone(id: string): void }) => void): void {
    change({
      addZone: (zone) => {
        zoneCount += 1;
        const id = `z${zoneCount}`;
        this.zones.set(id, zone);
        this.host.append(zone.domNode);
        return id;
      },
      removeZone: (id) => {
        this.zones.get(id)?.domNode.remove();
        this.zones.delete(id);
      },
    });
  }
  addOverlayWidget(widget: { getDomNode(): HTMLElement }): void { this.host.append(widget.getDomNode()); }
  removeOverlayWidget(widget: { getDomNode(): HTMLElement }): void { widget.getDomNode().remove(); }
  getLayoutInfo(): { contentLeft: number; contentWidth: number; verticalScrollbarWidth: number } { return { contentLeft: 60, contentWidth: 800, verticalScrollbarWidth: 14 }; }
  onDidLayoutChange(): { dispose(): void } { return { dispose: () => undefined }; }
  /** The zones standing, in the order they were added. */
  shownZones(): FakeZone[] { return [...this.zones.values()]; }
  onKeyDown(listener: KeyListener): { dispose(): void } {
    this.keys = [...this.keys, listener];
    return { dispose: () => { this.keys = this.keys.filter((l) => l !== listener); } };
  }
  /** What a key pressed while the editor has the focus does. */
  pressKey(key: string): void {
    for (const listener of this.keys) listener({ browserEvent: new KeyboardEvent('keydown', { key }) });
  }
  onDidDispose(listener: Listener): { dispose(): void } {
    this.ends = [...this.ends, listener];
    return { dispose: () => { this.ends = this.ends.filter((l) => l !== listener); } };
  }
  dispose(): void {
    this.disposed = true;
    for (const end of this.ends) end();
  }
}

/** The changes pane's diff editor (#668): the base's model on the left, a FakeEditor over the file's model on the right. */
export class FakeDiffEditor {
  static all: FakeDiffEditor[] = [];
  readonly original: FakeModel;
  readonly modifiedEditor: FakeEditor;
  disposed = false;

  constructor(host: HTMLElement, original: FakeModel, modified: FakeModel, onSave: () => void, fontFamily: string, onSaveUnformatted: () => void) {
    this.original = original;
    this.modifiedEditor = new FakeEditor(host, modified, onSave, fontFamily, onSaveUnformatted);
    FakeDiffEditor.all.push(this);
  }

  getModifiedEditor(): FakeEditor { return this.modifiedEditor; }
  dispose(): void {
    this.disposed = true;
    this.modifiedEditor.dispose();
  }
}

const LANGUAGES = [{ id: 'typescript', extensions: ['.ts', '.tsx'] }, { id: 'markdown', extensions: ['.md'] }, { id: 'dockerfile', filenames: ['Dockerfile'] }, { id: 'python', extensions: ['.py'] }];

/** What @/lib/monaco exports, faked. */
export const monacoModule = {
  applied: [] as [string, string][],
  applySyntaxFor(model: FakeModel, path: string): void { monacoModule.applied.push([model.language, path]); },
  attachGutterMarks, // the real marks, over the fake editor (#668)
  monaco: {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: {
      createModel: (text: string, language?: string) => new FakeModel(text, language ?? 'plaintext'),
      create: (host: HTMLElement, { model, fontFamily }: { model: FakeModel; fontFamily?: string }) => new FakeEditor(host, model, () => undefined, fontFamily ?? ''),
      MouseTargetType: { GUTTER_LINE_DECORATIONS },
      EditorOption: { lineHeight: LINE_HEIGHT_OPTION },
      setModelMarkers: (model: FakeModel, owner: string, list: unknown[]) => { markers.push({ model, owner, list }); },
      setModelLanguage: (model: FakeModel, language: string) => { model.language = language; }, // an untitled buffer saved as a file (#818)
      registerEditorOpener: () => ({ dispose: () => undefined }),
    },
    languages: {
      getLanguages: () => LANGUAGES,
      CompletionItemKind: { Text: 18, Method: 0, Function: 1 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: register('completion'), registerHoverProvider: register('hover'),
      registerDefinitionProvider: register('definition'), registerCodeActionProvider: register('codeAction'),
    },
  },
  createEditor: (host: HTMLElement, model: FakeModel, { fontFamily, onSave, onSaveUnformatted }: { fontFamily: string; onSave(): void; onSaveUnformatted(): void }) => {
    const editor = new FakeEditor(host, model, onSave, fontFamily, onSaveUnformatted);
    return { editor, dispose: () => editor.dispose() };
  },
  createDiffEditor: (host: HTMLElement, original: FakeModel, modified: FakeModel, { fontFamily, onSave, onSaveUnformatted }: { fontFamily: string; onSave(): void; onSaveUnformatted(): void }) => {
    const editor = new FakeDiffEditor(host, original, modified, onSave, fontFamily, onSaveUnformatted);
    return { editor, dispose: () => editor.dispose() };
  },
};

export function resetMonacoFakes(): void {
  FakeModel.all = [];
  FakeEditor.all = [];
  FakeDiffEditor.all = [];
  monacoModule.applied = [];
  registered.length = 0;
  markers.length = 0;
}
