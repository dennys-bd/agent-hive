// Monaco's hidden areas (#319): the internal call the folding contribution makes (codeEditorWidget.js, monaco-editor 0.52), merged per source
// by the view model. A file of its own: monaco-internals.d.ts is a global script, and the import an augmentation needs would turn its ambient
// module into an augmentation of an untyped one.
import type { IRange } from 'monaco-editor';

declare module 'monaco-editor' {
  export namespace editor {
    interface ICodeEditor {
      setHiddenAreas(ranges: readonly IRange[], source?: unknown): void;
    }
  }
}
