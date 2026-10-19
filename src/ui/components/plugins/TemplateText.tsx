import type { editor } from 'monaco-editor';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { AnnotationMargin } from '@/components/plugins/Annotations';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import type { Annotations } from '@/hooks/use-annotations';
import { t } from '@/i18n';
import { languageOf, loadMonaco } from '@/lib/editor-models';
import { type Chip, type Decoration, isMarkdown, type LineRange } from '@/lib/template-view';

type View = editor.IStandaloneCodeEditor;
/** A map click (decision 19): the line to put the cursor on; n changes on every click, so the same line twice reveals twice. */
export interface Reveal { line: number; n: number }
/** The open chip's popover (#322): the content of the chain's form at the chip of `line`; Esc and a click outside call onClose. */
export interface ChipPopover { line: number; content: ReactNode; onClose(): void }
export interface TemplateTextProps {
  modelKey: string; // a new key, a new model: the item, the file and the preview's workspace
  path: string; text: string; isReadOnly: boolean; fontFamily: string;
  hidden: readonly LineRange[]; decorations: readonly Decoration[]; chips: readonly Chip[]; reveal?: Reveal;
  onChange(text: string): void; onSave(): void;
  onChip?(line: number): void; // #322: opens the chain's popover
  popover?: ChipPopover;
  annotations?: Annotations; anchorOf?(line: number): number; // #327: the margin's annotations, each at the line the look shows it on
}

const SAME_LINE = (line: number): number => line;

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

// The conditions column (#319): each chip at its marker's line as the text scrolls; the open one anchors its popover, upward (#322, decision 13)
interface ChipsProps { chips: readonly Chip[]; topOf(line: number): number; onChip?(line: number): void; popover?: ChipPopover }

function Chips({ chips, topOf, onChip, popover }: ChipsProps) {
  const openChip = useRef<HTMLButtonElement>(null);
  if (chips.length === 0) return null;
  const close = (): void => { openChip.current?.focus(); popover?.onClose(); }; // the content unmounts with the focus in it: it goes back to the chip
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the chips column
    <div role="group" aria-label={t('plugins.editor.conditions')}>
      {chips.map((chip) => {
        const isOpen = popover?.line === chip.line;
        // Every chip sits under a Popover, open or not, so opening one keeps its button (and its focus) instead of remounting it
        return (
          <Popover key={chip.line} open={isOpen} onOpenChange={(next) => { if (!next) close(); }}>
            <PopoverAnchor asChild>
              <button
                ref={isOpen ? openChip : undefined} type="button" onClick={() => (isOpen ? close() : onChip?.(chip.line))} style={{ top: topOf(chip.line) }}
                className="absolute left-2 max-w-[214px] truncate rounded-full border px-2 font-mono text-[11px] text-muted-foreground hover:bg-accent"
              >
                {chip.label}
              </button>
            </PopoverAnchor>
            {isOpen && <PopoverContent side="top" align="end" aria-label={t('plugins.chain.popover')} className="w-[420px] p-3"
                // the open chip toggles it: its pointerdown is no outside click, or the click after it would reopen what Radix just closed
                onPointerDownOutside={(event) => { if (openChip.current?.contains(event.target as Node)) event.preventDefault(); }}
              >{popover.content}</PopoverContent>}
          </Popover>
        );
      })}
    </div>
  );
}

/** The skill editor's text (#319, handoff 11b): the buffer in Monaco with the look SkillEditor computed, ⌘S through Monaco's own save action
 * as EditorPane binds it, and the margin beside it: each condition chip at its marker's line and, #327, each annotation's card or note at its
 * line, as the text scrolls. */
export function TemplateText(props: TemplateTextProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useTemplateEditor(host, props);
  useLook(view, props);
  const scrollTop = useScrollTop(view);
  const { chips, onChip, popover, annotations, anchorOf = SAME_LINE } = props;
  const topOf = (line: number): number => (view?.getTopForLineNumber(line) ?? 0) - scrollTop;
  const marks = annotations?.list ?? [];
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div ref={host} className="min-h-0 min-w-0 flex-1" />
      {(chips.length > 0 || marks.length > 0) && (
        <div className="relative w-[230px] shrink-0 overflow-hidden border-l">
          <Chips chips={chips} topOf={topOf} onChip={onChip} popover={popover} />
          {annotations && marks.length > 0 && (
            <AnnotationMargin annotations={annotations} tops={marks.map((a) => topOf(anchorOf(a.line)))} chipTops={chips.map((chip) => topOf(chip.line))} />
          )}
        </div>
      )}
    </div>
  );
}
