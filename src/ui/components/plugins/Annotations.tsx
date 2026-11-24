import { XIcon } from 'lucide-react';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FindingKind } from '../../../reviewer';
import type { LintAnnotation, LintCheck, Severity } from '../../../template-lint';
import { Button } from '@/components/ui/button';
import { type Annotations, checkOf, type EditorAnnotation, isAgent } from '@/hooks/use-annotations';
import { type MessageKey, t } from '@/i18n';
import { kindOf } from '@/lib/annotation-fix';
import { CARD_HEIGHT, layoutMargin, openPlacement } from '@/lib/annotation-layout';

// A headline and a body per check: the lint's own title and body are English, so the card fills the viewer's language from the fields
const COPY: Record<LintCheck, { title: MessageKey; body: MessageKey }> = {
  parse: { title: 'plugins.annotations.parse.title', body: 'plugins.annotations.parse.body' },
  render: { title: 'plugins.annotations.render.title', body: 'plugins.annotations.render.body' },
  undeclared: { title: 'plugins.annotations.undeclared.title', body: 'plugins.annotations.undeclared.body' },
  unused: { title: 'plugins.annotations.unused.title', body: 'plugins.annotations.unused.body' },
  required: { title: 'plugins.annotations.required.title', body: 'plugins.annotations.required.body' },
  reference: { title: 'plugins.annotations.reference.title', body: 'plugins.annotations.reference.body' },
  callRequired: { title: 'plugins.annotations.callRequired.title', body: 'plugins.annotations.callRequired.body' },
  value: { title: 'plugins.annotations.value.title', body: 'plugins.annotations.value.body' }, // #621
  heading: { title: 'plugins.annotations.heading.title', body: 'plugins.annotations.heading.body' },
  taskCondition: { title: 'plugins.annotations.taskCondition.title', body: 'plugins.annotations.taskCondition.body' },
};
// Yellow and red are status colours (design-system.md): the severity is the one colour a card carries, in its border and a note's text (#492)
const EDGE: Record<Severity, string> = {
  red: 'border-[color-mix(in_oklab,var(--destructive)_45%,var(--border))]', yellow: 'border-[color-mix(in_oklab,var(--waiting)_45%,var(--border))]',
};
const NOTE_TEXT: Record<Severity, string> = { red: 'text-destructive', yellow: 'text-waiting' };
const ENGINE_CHECKS: readonly LintCheck[] = ['parse', 'render']; // their title is the engine's message, shown as the card's detail

// #981: every finding's kind after its title, in the agent tag's muted style; the copy says correção / conselho, the code fix / advice
const KIND_TAG: Record<FindingKind, MessageKey> = { fix: 'plugins.annotations.kind.fix', advice: 'plugins.annotations.kind.advice' };
const TAG = 'shrink-0 rounded border px-1 font-normal text-muted-foreground';

const varsOf = (a: LintAnnotation): Record<string, string | number> => ({
  variable: a.variable ?? '', ref: a.ref ?? '', level: a.level ?? '', workspaces: (a.workspaces ?? []).join(', '),
});
const keyOf = (a: EditorAnnotation): string => `${a.line}\0${checkOf(a)}\0${a.title}`;

/** The annotation's headline in the viewer's language: the note's text and the card's first line. The agent writes its own (#329). */
export const headlineOf = (a: EditorAnnotation): string => (isAgent(a) ? a.title : t(COPY[a.check].title, varsOf(a)));
const bodyOf = (a: EditorAnnotation): string => (isAgent(a) ? a.body : t(COPY[a.check].body, varsOf(a)));

/** The margin's annotations, with #982's entry point to the agent bar when the editor gives one: "ask the agent" needs it (#981). */
type CardAnnotations = Annotations & { passage?(request: string, line: number): void };
interface SlotProps { annotation: EditorAnnotation; annotations: CardAnnotations; top: number; canFix: boolean; lineHeight: number; columnHeight: number }
type Place = Pick<SlotProps, 'top' | 'lineHeight' | 'columnHeight'>;
interface DiffRow { sign: '−' | '+'; line: string; key: string }

// #980: closed, the card is as tall as the layout reserves; open, it is its content's height, measured once drawn, placed by openPlacement
function useCardPlace(isOpen: boolean, annotation: EditorAnnotation, { top, lineHeight, columnHeight }: Place) {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: annotation is a trigger, not read inside: another text is another height
  useLayoutEffect(() => { setHeight(isOpen ? ref.current?.offsetHeight : undefined); }, [isOpen, annotation]);
  let style: CSSProperties = { top, height: CARD_HEIGHT };
  if (isOpen) style = height === undefined ? { top } : openPlacement(top, height, lineHeight, columnHeight);
  return { ref, style };
}

// '' is a deletion: it has no line to show
const rowsOf = (sign: DiffRow['sign'], text: string): DiffRow[] =>
  (text === '' ? [] : text.split('\n')).map((line, n) => ({ sign, line, key: `${sign}${n}` }));

// #981: an open agent fix's before and after, as design-system.md draws a diff: foreground mono text, the span on diff-del, the replacement
// on diff-add, the sign muted
function FixDiff({ span, replacement }: { span: string; replacement: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the proposed fix
    <div role="group" aria-label={t('plugins.annotations.fixLabel')} className="flex flex-col overflow-hidden rounded border font-mono text-foreground">
      {[...rowsOf('−', span), ...rowsOf('+', replacement)].map(({ sign, line, key }) => (
        <span key={key} className={`whitespace-pre-wrap px-1.5 ${sign === '−' ? 'bg-diff-del' : 'bg-diff-add'}`}>
          <span aria-hidden="true" className="inline-block w-3 text-muted-foreground">{sign}</span>{line}
        </span>
      ))}
    </div>
  );
}

// #981: a fix offers apply, an agent advice hands its title and body to the agent bar with its line; neither while the text is read-only
// (#331: the bar takes no request then, and applyEdit refuses a locked text). Dismiss stays on every card
function CardActions({ annotation, annotations, canFix }: Pick<SlotProps, 'annotation' | 'annotations' | 'canFix'>) {
  const kind = kindOf(annotation);
  const { passage } = annotations;
  const canAsk = canFix && isAgent(annotation) && kind === 'advice' && passage !== undefined;
  return (
    <span className="mt-auto flex gap-1.5">
      {canFix && kind === 'fix' && <Button type="button" size="xs" onClick={() => annotations.apply(annotation)}>{t('plugins.annotations.apply')}</Button>}
      {canAsk && (
        <Button type="button" size="xs" variant="outline" onClick={() => passage?.(`${annotation.title}: ${annotation.body}`, annotation.line)}>
          {t('plugins.annotations.askAgent')}
        </Button>
      )}
      <Button type="button" size="xs" variant="outline" disabled={!annotations.canDismiss} onClick={() => annotations.dismiss(annotation)}>{t('plugins.annotations.dismiss')}</Button>
    </span>
  );
}

function Card({ annotation, annotations, canFix, ...place }: SlotProps) {
  const isOpen = annotations.open === annotation;
  const { ref, style } = useCardPlace(isOpen, annotation, place);
  return (
    <article
      ref={ref} aria-label={headlineOf(annotation)} data-open={isOpen} style={style}
      className={`absolute right-2 left-2 flex flex-col gap-1.5 rounded-[6px] border bg-card px-2.5 py-2 text-xs ${EDGE[annotation.severity]} ${isOpen ? 'z-10 ring-1 ring-ring' : 'overflow-hidden'}`}
    >
      <span className="flex min-w-0 items-center gap-1.5 font-semibold">
        <span className={isOpen ? 'min-w-0' : 'truncate'}>{headlineOf(annotation)}</span>
        {/* #329: the issue's "marked as the agent's", after the title (#492), then the kind (#981); the severity stays the card's one colour */}
        {isAgent(annotation) && <span className={TAG}>{t('plugins.annotations.agent')}</span>}
        <span className={TAG}>{t(KIND_TAG[kindOf(annotation)])}</span>
        {isOpen && (
          <Button type="button" size="icon-xs" variant="ghost" aria-label={t('plugins.annotations.close')} title={t('plugins.annotations.closeHint')} onClick={annotations.close} className="ml-auto shrink-0">
            <XIcon />
          </Button>
        )}
      </span>
      {/* #980: closed, two lines of the body open the card; open, the whole body is text to select */}
      {isOpen
        ? <p className="cursor-text text-soft">{bodyOf(annotation)}</p>
        : <button type="button" onClick={() => annotations.openAt(annotation)} className="line-clamp-2 cursor-pointer text-left text-soft hover:text-foreground">{bodyOf(annotation)}</button>}
      {!isAgent(annotation) && ENGINE_CHECKS.includes(annotation.check) && <p title={annotation.title} className="truncate font-mono text-muted-foreground">{annotation.title}</p>}
      {isOpen && isAgent(annotation) && annotation.kind === 'fix' && <FixDiff span={annotation.span} replacement={annotation.replacement} />}
      <CardActions annotation={annotation} annotations={annotations} canFix={canFix} />
    </article>
  );
}

function Note({ annotation, annotations, top }: SlotProps) {
  return (
    <button
      type="button" onClick={() => annotations.openAt(annotation)} style={{ top }}
      className={`absolute right-2 left-2 truncate px-1.5 text-left text-xs hover:underline ${NOTE_TEXT[annotation.severity]}`}
    >
      {headlineOf(annotation)}
    </button>
  );
}

/** The margin's annotations (#327, handoff 11b): a card where it covers nothing, else a one-line note that opens it. The open one is always a
 * card, drawn over the rest, whole and growing upward near the column's end (#980); × or Esc closes it. `tops[i]` is `annotations.list[i]`'s top, as the chips' are theirs. #331: no fix while the text
 * is read-only (the agent working or proposing, the read-only original). */
interface MarginProps { annotations: CardAnnotations; tops: readonly number[]; chipTops: readonly number[]; canFix?: boolean; lineHeight: number; columnHeight: number }
export function AnnotationMargin({ annotations, tops, chipTops, canFix = true, lineHeight, columnHeight }: MarginProps) {
  const { list, open, close } = annotations;
  useEffect(() => {
    if (open === undefined) return undefined;
    // Monaco's widgets and dialogs prevent the Esc they handle: it must not close the card too
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
  const slots = layoutMargin(chipTops, tops);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a border and a legend; the group only names the annotations
    <div role="group" aria-label={t('plugins.annotations.label')}>
      {list.map((annotation, index) => {
        const slot = slots[index];
        const Slot = slot.kind === 'card' || annotation === open ? Card : Note;
        return <Slot key={keyOf(annotation)} annotation={annotation} annotations={annotations} top={slot.top} canFix={canFix} lineHeight={lineHeight} columnHeight={columnHeight} />;
      })}
    </div>
  );
}
