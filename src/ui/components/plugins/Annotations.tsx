import { useEffect } from 'react';
import type { LintAnnotation, LintCheck, Severity } from '../../../template-lint';
import { Button } from '@/components/ui/button';
import { type Annotations, checkOf, type EditorAnnotation, isAgent } from '@/hooks/use-annotations';
import { type MessageKey, t } from '@/i18n';
import { hasFix } from '@/lib/annotation-fix';
import { CARD_HEIGHT, layoutMargin } from '@/lib/annotation-layout';

// A headline and a body per check: the lint's own title and body are English, so the card fills the viewer's language from the fields
const COPY: Record<LintCheck, { title: MessageKey; body: MessageKey }> = {
  parse: { title: 'plugins.annotations.parse.title', body: 'plugins.annotations.parse.body' },
  render: { title: 'plugins.annotations.render.title', body: 'plugins.annotations.render.body' },
  undeclared: { title: 'plugins.annotations.undeclared.title', body: 'plugins.annotations.undeclared.body' },
  unused: { title: 'plugins.annotations.unused.title', body: 'plugins.annotations.unused.body' },
  required: { title: 'plugins.annotations.required.title', body: 'plugins.annotations.required.body' },
  reference: { title: 'plugins.annotations.reference.title', body: 'plugins.annotations.reference.body' },
  callRequired: { title: 'plugins.annotations.callRequired.title', body: 'plugins.annotations.callRequired.body' },
  heading: { title: 'plugins.annotations.heading.title', body: 'plugins.annotations.heading.body' },
};
// Yellow and red are status colours (design-system.md): the severity is the one colour a card carries
const DOT: Record<Severity, string> = { red: 'bg-destructive', yellow: 'bg-waiting' };
const EDGE: Record<Severity, string> = { red: 'border-l-destructive', yellow: 'border-l-waiting' };
const ENGINE_CHECKS: readonly LintCheck[] = ['parse', 'render']; // their title is the engine's message, shown as the card's detail

const varsOf = (a: LintAnnotation): Record<string, string | number> => ({
  variable: a.variable ?? '', ref: a.ref ?? '', level: a.level ?? '', workspaces: (a.workspaces ?? []).join(', '),
});
const keyOf = (a: EditorAnnotation): string => `${a.line}\0${checkOf(a)}\0${a.title}`;

/** The annotation's headline in the viewer's language: the note's text and the card's first line. The agent writes its own (#329). */
export const headlineOf = (a: EditorAnnotation): string => (isAgent(a) ? a.title : t(COPY[a.check].title, varsOf(a)));
const bodyOf = (a: EditorAnnotation): string => (isAgent(a) ? a.body : t(COPY[a.check].body, varsOf(a)));

interface SlotProps { annotation: EditorAnnotation; annotations: Annotations; top: number; canFix: boolean }

function Headline({ annotation }: { annotation: EditorAnnotation }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={`size-1.5 shrink-0 rounded-full ${DOT[annotation.severity]}`} />
      <span className="truncate">{headlineOf(annotation)}</span>
    </span>
  );
}

function Card({ annotation, annotations, top, canFix }: SlotProps) {
  const isOpen = annotations.open === annotation;
  return (
    <article
      aria-label={headlineOf(annotation)} data-open={isOpen} style={{ top, height: CARD_HEIGHT }}
      className={`absolute right-2 left-2 flex flex-col gap-1 overflow-hidden rounded-md border border-l-2 bg-popover p-2 text-[11px] ${EDGE[annotation.severity]} ${isOpen ? 'z-10 ring-1 ring-ring' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-1.5 font-medium">
        {/* #329: the issue's "marked as the agent's"; the severity stays the card's one colour */}
        {isAgent(annotation) && <span className="shrink-0 rounded border px-1 font-normal text-[10px] text-muted-foreground">{t('plugins.annotations.agent')}</span>}
        <Headline annotation={annotation} />
      </span>
      <p className="line-clamp-2 text-muted-foreground">{bodyOf(annotation)}</p>
      {!isAgent(annotation) && ENGINE_CHECKS.includes(annotation.check) && <p title={annotation.title} className="truncate font-mono text-muted-foreground">{annotation.title}</p>}
      <span className="mt-auto flex gap-1">
        {canFix && hasFix(annotation) && <Button type="button" size="xs" variant="outline" onClick={() => annotations.apply(annotation)}>{t('plugins.annotations.apply')}</Button>}
        <Button type="button" size="xs" variant="ghost" disabled={!annotations.canDismiss} onClick={() => annotations.dismiss(annotation)}>{t('plugins.annotations.dismiss')}</Button>
      </span>
    </article>
  );
}

function Note({ annotation, annotations, top }: SlotProps) {
  return (
    <button
      type="button" onClick={() => annotations.openAt(annotation)} style={{ top }}
      className="absolute right-2 left-2 truncate rounded border bg-popover px-1.5 text-left text-[11px] hover:bg-accent"
    >
      <Headline annotation={annotation} />
    </button>
  );
}

/** The margin's annotations (#327, handoff 11b): a card where it covers nothing, else a one-line note that opens it. The open one is always a
 * card, drawn over the rest; Esc closes it. `tops[i]` is `annotations.list[i]`'s top, as the chips' are theirs. #331: no fix while the text
 * is read-only (the agent working or proposing, the read-only original). */
export function AnnotationMargin({ annotations, tops, chipTops, canFix = true }: { annotations: Annotations; tops: readonly number[]; chipTops: readonly number[]; canFix?: boolean }) {
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
        return <Slot key={keyOf(annotation)} annotation={annotation} annotations={annotations} top={slot.top} canFix={canFix} />;
      })}
    </div>
  );
}
