// The one place Monaco is set up (#717). Only the base editor worker; highlighting comes from the Monarch tokenizers (basic-languages, plus
// JSON's own in monaco-json.ts since Monaco ships JSON only as a language service, #793), or a syntax package's TextMate grammar once
// installed (#780). No built-in language service: without the project's tsconfig and node_modules the
// TypeScript one marks every import, and wrong red squiggles are worse than none; the language services are the Hive's own LSP client (#780). Loaded only through import() (editor-models.ts, EditorPane.tsx): a chunk of its own, fetched with the first file opened.
import 'monaco-editor/esm/vs/editor/edcore.main';
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { passHiveKeys } from '@/lib/monaco-keys';
import { isMac } from '@/lib/shortcut-bindings';
import { followEditorTheme } from '@/lib/monaco-themes';
import { applySyntax } from '@/lib/monaco-textmate';
import { registerJson } from '@/lib/monaco-json';
import { extensionOf, LANGUAGES, languageDef, languageOf } from '../../languages';

// Monaco reads its worker from the global it declares; assigned rather than declared, so its typing never matters
const environment: monaco.Environment = { getWorker: () => new EditorWorker() };
Object.assign(self, { MonacoEnvironment: environment });
followEditorTheme(monaco.editor); // once: Monaco's theme is the page's, never stopped

// Every catalog extension Monaco does not know gets the catalog language's id (#780), so its model has a language a syntax package can paint;
// a second register of an id Monaco has merges the extension into it
function registerCatalogLanguages(): void {
  const known = new Set(monaco.languages.getLanguages().flatMap((l) => l.extensions ?? []));
  for (const def of LANGUAGES) {
    const missing = def.extensions.filter((e) => !known.has(e));
    if (def.id !== 'other' && missing.length > 0) monaco.languages.register({ id: def.id, extensions: missing });
  }
}
registerJson(monaco.languages); // first: once Monaco knows .json and .jsonc, the catalog loop no longer puts them under `web`
registerCatalogLanguages();

/** Paints the model with its language's syntax package when one is installed (#780); Monarch stays otherwise. */
export function applySyntaxFor(model: monaco.editor.ITextModel, path: string): void {
  const language = languageOf(path);
  const syntax = language === undefined ? undefined : languageDef(language).syntax;
  if (syntax === undefined || syntax === 'builtin') return;
  void applySyntax(monaco.languages, syntax, model.getLanguageId(), extensionOf(path));
}

export { monaco };
export { attachGutterMarks } from '@/lib/gutter-marks'; // #668: the change marks and their peek, in Monaco's own chunk

/** fontFamily: the terminal's (#376). onSave: ⌘S, a save that formats (#749); onSaveUnformatted: ⌥⌘S (Ctrl+Shift+S off macOS), one that
 * does not. Monaco's own commands, since no Hive shortcut binds either; the editor owns the keys while it has the focus. */
export interface EditorOptions { fontFamily: string; onSave(): void; onSaveUnformatted(): void }
export interface OpenEditor { editor: monaco.editor.IStandaloneCodeEditor; dispose(): void }
export interface OpenDiffEditor { editor: monaco.editor.IStandaloneDiffEditor; dispose(): void }

// ⌘S and ⌥⌘S on an editor (#717, #749). addAction, not addCommand: Monaco keeps addCommand's keybinding in one global service, so with two
// editors open ⌘S ran the last one created
function addSaveActions(editor: monaco.editor.IStandaloneCodeEditor, { onSave, onSaveUnformatted }: Pick<EditorOptions, 'onSave' | 'onSaveUnformatted'>): void {
  editor.addAction({ id: 'hive.save', label: 'Save', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: onSave });
  const unformatted = monaco.KeyMod.CtrlCmd | (isMac() ? monaco.KeyMod.Alt : monaco.KeyMod.Shift) | monaco.KeyCode.KeyS;
  editor.addAction({ id: 'hive.saveUnformatted', label: 'Save without formatting', keybindings: [unformatted], run: onSaveUnformatted });
}

/** An editor over `model` in `host` (#717): the Hive's keys passed by, ⌘S saving. Its dispose leaves the model to editor-models.ts. */
export function createEditor(host: HTMLElement, model: monaco.editor.ITextModel, { fontFamily, onSave, onSaveUnformatted }: EditorOptions): OpenEditor {
  const stopKeys = passHiveKeys(host);
  const editor = monaco.editor.create(host, { model, fontFamily, automaticLayout: true, scrollBeyondLastLine: false });
  addSaveActions(editor, { onSave, onSaveUnformatted });
  return {
    editor,
    dispose: () => {
      stopKeys();
      editor.dispose();
    },
  };
}

/** The changes pane's diff editor in `host` (#668): `original` read only on the left, `modified` (the file's own model) editable on the right,
 * inline once the pane is narrow, Monaco's revert arrows in the margin; the Hive's keys passed by, ⌘S and ⌥⌘S on the right side. Its dispose
 * leaves both models to their owners. */
export function createDiffEditor(host: HTMLElement, original: monaco.editor.ITextModel, modified: monaco.editor.ITextModel, { fontFamily, onSave, onSaveUnformatted }: EditorOptions): OpenDiffEditor {
  const stopKeys = passHiveKeys(host);
  const editor = monaco.editor.createDiffEditor(host, {
    fontFamily, automaticLayout: true, scrollBeyondLastLine: false, originalEditable: false, renderMarginRevertIcon: true, useInlineViewWhenSpaceIsLimited: false,
  });
  editor.setModel({ original, modified });
  addSaveActions(editor.getModifiedEditor(), { onSave, onSaveUnformatted });
  return {
    editor,
    dispose: () => {
      stopKeys();
      editor.dispose();
    },
  };
}
