import type { editor } from 'monaco-editor';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import { languageOf, loadMonaco } from '@/lib/editor-models';
import { type Chip, type Decoration, isMarkdown, type LineRange } from '@/lib/template-view';

type View = editor.IStandaloneCodeEditor;
/** A map click (decision 19): the line to put the cursor on; n changes on every click, so the same line twice reveals twice. */
export interface Reveal { line: number; n: number }
export interface TemplateTextProps {
  modelKey: string; // a new key, a new model: the item, the file and the preview's workspace
  path: string; text: string; isReadOnly: boolean; fontFamily: string;
  hidden: readonly LineRange[]; decorations: readonly Decoration[]; chips: readonly Chip[]; reveal?: Reveal;
  onChange(text: string): void; onSave(): void;
  onChip?(line: number): void; // inert in #319; 3.8's popover opens here
}

const HIDDEN_SOURCE = 'hive.template'; // Monaco merges hidden areas per source: the folding contribution keeps its own
const LAST_COLUMN = Number.MAX_SAFE_INTEGER; // Monaco clamps a decoration's range to its line

const toRange = ({ from, to }: LineRange) => ({ startLineNumber: from, startColumn: 1, endLineNumber: to, endColumn: 1 });
function toDecoration(d: Decoration): editor.IModelDeltaDecoration {
  const range = { startLineNumber: d.line, startColumn: d.from ?? 1, endLineNumber: d.line, endColumn: d.to ?? LAST_COLUMN };
  return { range, options: d.isBackground === true ? { isWholeLine: true, className: d.className } : { inlineClassName: d.className } };
}

// The editor over a model of its own, made per modelKey and disposed with it: the buffer is useItemEditor's, the model only shows it. The
// latest props reach Monaco's listeners through a ref
function useTemplateEditor(host: RefObject<HTMLDivElement | null>, props: TemplateTextProps): View | undefined {
  const [view, setView] = useState<View>();
  const latest = useRef(props);
  useEffect(() => { latest.current = props; });
  const { modelKey, path } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: modelKey is not read inside, but a new key must rebuild the model
  useEffect(() => {
    const element = host.current;
    if (element === null) return undefined;
    let live = true;
    let dispose = (): void => undefined;
    void loadMonaco().then(({ createEditor, monaco }) => {
      if (!live) return;
      const language = isMarkdown(path) ? 'markdown' : languageOf(monaco.languages.getLanguages(), path);
      const model = monaco.editor.createModel(latest.current.text, language);
      const save = (): void => latest.current.onSave(); // no formatter here: ⌥⌘S saves the same way
      const open = createEditor(element, model, { fontFamily: latest.current.fontFamily, onSave: save, onSaveUnformatted: save });
      // a text the props gave is not reported back as an edit
      const typing = model.onDidChangeContent(() => { if (model.getValue() !== latest.current.text) latest.current.onChange(model.getValue()); });
      setView(open.editor);
      dispose = () => { typing.dispose(); open.dispose(); model.dispose(); };
    });
    return () => { live = false; dispose(); setView(undefined); };
  }, [host, modelKey, path]);
  return view;
}

// What the props say Monaco shows: the text, read-only and the font, the hidden lines, the marks, and the cursor of a map click
function useLook(view: View | undefined, { text, isReadOnly, fontFamily, hidden, decorations, reveal }: TemplateTextProps): void {
  useEffect(() => {
    const model = view?.getModel();
    if (model && model.getValue() !== text) model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null); // a move: one undoable edit
  }, [view, text]);
  useEffect(() => { view?.updateOptions({ readOnly: isReadOnly, fontFamily }); }, [view, isReadOnly, fontFamily]);
  useEffect(() => { view?.setHiddenAreas(hidden.map(toRange), HIDDEN_SOURCE); }, [view, hidden]);
  useEffect(() => {
    if (view === undefined) return undefined;
    const marks = view.createDecorationsCollection();
    marks.set(decorations.map(toDecoration));
    return () => marks.clear();
  }, [view, decorations]);
  // A reveal is one click: a view rebuilt for another "view as" must not replay the last one on lines of the old look
  const applied = useRef<number>(undefined);
  useEffect(() => {
    if (view === undefined || reveal === undefined || applied.current === reveal.n) return;
    applied.current = reveal.n;
    view.setPosition({ lineNumber: reveal.line, column: 1 });
    view.revealLineInCenter(reveal.line);
    view.focus();
  }, [view, reveal]);
}

function useScrollTop(view: View | undefined): number {
  const [top, setTop] = useState(0);
  useEffect(() => {
    if (view === undefined) return undefined;
    setTop(view.getScrollTop());
    const scrolling = view.onDidScrollChange((event) => setTop(event.scrollTop));
    return () => scrolling.dispose();
  }, [view]);
  return top;
}

/** The skill editor's text (#319, handoff 11b): the buffer in Monaco with the look SkillEditor computed, ⌘S through Monaco's own save action
 * as EditorPane binds it, and the conditions column beside it, each chip at its marker's line as the text scrolls. */
export function TemplateText(props: TemplateTextProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useTemplateEditor(host, props);
  useLook(view, props);
  const scrollTop = useScrollTop(view);
  const { chips, onChip } = props;
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div ref={host} className="min-h-0 min-w-0 flex-1" />
      {chips.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the chips column
        <div role="group" aria-label={t('plugins.editor.conditions')} className="relative w-[230px] shrink-0 overflow-hidden border-l">
          {chips.map((chip) => (
            <button
              key={chip.line} type="button" onClick={() => onChip?.(chip.line)} style={{ top: (view?.getTopForLineNumber(chip.line) ?? 0) - scrollTop }}
              className="absolute left-2 max-w-[214px] truncate rounded-full border px-2 font-mono text-[11px] text-muted-foreground hover:bg-accent"
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
