import { useLayoutEffect, useRef, useState } from 'react';
import type { PrData } from '../../types';
import { Editable, fieldSaver, useEditable } from '@/components/Editable';
import { IssueMarkdown } from '@/components/IssueMarkdown';
import { AssigneeCell } from '@/components/ProjectRow';
import { Button } from '@/components/ui/button';
import { prPath } from '@/hooks/use-pr';
import { t, tPlural } from '@/i18n';
import { relativeTime } from '@/lib/home';

const MUTED = 'text-muted-foreground';
const BODY_MAX = 148; // px: handoff 6's bodyMax, where a long description is clipped
const BODY_LINE = 21; // px: the body's line height, the unit "+N lines" counts in
const SESSION_SHOWN = 8; // the session id's first characters, as the handoff's `via sessão f9f0456a`

/** Whether the page may edit the PR's title and description (#758): an open PR GitHub says the login can update. */
export const canEditPr = (pr: PrData): boolean => pr.state === 'open' && pr.canEdit;

// A save of the PR's title or description (#758), as the issue page's: with the updatedAt the edit started on; a 409 says the PR changed
const saverOf = (pr: PrData, onChanged: () => Promise<void>): ReturnType<typeof fieldSaver> => fieldSaver(prPath(pr.url), t('pr.changed'), onChanged);

/** The PR's title (#758, handoff 03 "Topo"): 20px/600 with edit, as the issue page's; plain on a PR the page may not edit. */
export function PrTitle({ pr, onChanged }: { pr: PrData; onChanged(): Promise<void> }) {
  const heading = <h1 className="font-semibold text-[20px] leading-[26px] [text-wrap:pretty]">{pr.title}</h1>;
  if (!canEditPr(pr)) return heading;
  return <Editable label={t('issue.title')} value={pr.title} updatedAt={pr.updatedAt} isMultiline={false} changed={t('pr.changed')} onSave={saverOf(pr, onChanged)('title')}>{heading}</Editable>;
}

// The lines the clip hides (#62): the hidden height in body lines, 0 when the body fits
const hiddenLines = (height: number): number => Math.max(0, Math.ceil((height - BODY_MAX) / BODY_LINE));

// The rendered body's whole height, read on mount and on every resize: markdown sets headings, lists and code at heights of their own, so only
// the rendered body says how much the clip hides. A new body after a refresh, or a narrower window, measures again
function useBodyHeight() {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = (): void => setHeight(el.scrollHeight);
    const observer = new ResizeObserver(read);
    observer.observe(el);
    read();
    return () => observer.disconnect();
  }, []);
  return { ref, height };
}

// The body (#62, handoff 6): past 148px it is clipped with a 56px fade to the page and a footer that opens it, and opened, the footer collapses
// it again. Whole, with no fade or footer, while it fits. The measured div has no cap, so its height is the whole body's
function CollapsibleBody({ text, isOpen, onToggle }: { text: string; isOpen: boolean; onToggle(): void }) {
  const { ref, height } = useBodyHeight();
  const hidden = hiddenLines(height);
  const isClipped = hidden > 0 && !isOpen;
  return (
    <>
      <div className="px-4 py-3">
        <div className={isClipped ? 'relative max-h-[148px] overflow-hidden' : undefined}>
          <div ref={ref} className="text-[13px] leading-[21px]"><IssueMarkdown text={text} /></div>
          {isClipped && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-linear-to-t from-background" />}
        </div>
      </div>
      {hidden > 0 && (
        <button type="button" aria-expanded={isOpen} onClick={onToggle} className="flex gap-1.5 border-t px-4 py-2 text-left text-xs hover:bg-muted">
          <span>{isOpen ? t('pr.description.collapse') : t('pr.description.showAll')}</span>
          {!isOpen && <span className={MUTED}>{`· ${tPlural('pr.description.moreLines', hidden, { n: hidden })}`}</span>}
        </button>
      )}
    </>
  );
}

// opened · via session f9f0456a · 2 days (#62, handoff 6): the session only when the Hive recorded the one that opened the PR, its id in mono
function OpenedLine({ createdAt, sessionId }: { createdAt: string; sessionId?: string }) {
  const [before, after] = t('pr.description.viaSession').split('{id}');
  return (
    <span className={MUTED}>
      {t('pr.description.opened')}
      {sessionId !== undefined && <>{` · ${before}`}<span className="font-mono">{sessionId.slice(0, SESSION_SHOWN)}</span>{after}</>}
      {` · ${relativeTime(createdAt)}`}
    </span>
  );
}

export interface PrDescriptionProps { pr: PrData; sessionId?: string; onChanged(): Promise<void> }

/** description (#758, #62, handoff 6): a bordered panel. Its header holds the author's avatar and login, the opened line and, on a PR the page
 * may edit, edit; the body below is clipped while long and swaps for the edit form while editing. An empty body says so. */
export function PrDescription({ pr, sessionId, onChanged }: PrDescriptionProps) {
  const [isOpen, setIsOpen] = useState(false); // here, not in the body: a save remounts the body and must not collapse it again
  const editing = useEditable({ label: t('pr.description'), value: pr.body, updatedAt: pr.updatedAt, isMultiline: true, changed: t('pr.changed'), onSave: saverOf(pr, onChanged)('body') });
  const isEditing = editing.isEditing && canEditPr(pr); // a merge or a lost permission read by a poll closes the form a draft left open
  const body = pr.body.trim() === ''
    ? <p className={`px-4 py-3 text-[13px] ${MUTED}`}>{t('pr.description.empty')}</p>
    : <CollapsibleBody text={pr.body} isOpen={isOpen} onToggle={() => setIsOpen(!isOpen)} />;
  return (
    <section aria-label={t('pr.description')} className="flex max-w-[680px] flex-col rounded-lg border">
      <header className="flex items-center gap-2 border-b px-4 py-2.5 text-xs">
        <AssigneeCell logins={[pr.author]} />
        <span className="font-medium">{pr.author}</span>
        <OpenedLine createdAt={pr.createdAt} sessionId={sessionId} />
        <span className="flex-1" />
        {canEditPr(pr) && !isEditing && <Button type="button" size="xs" variant="outline" onClick={editing.edit}>{t('issue.edit')}</Button>}
      </header>
      {isEditing ? <div className="px-4 py-3">{editing.form}</div> : body}
    </section>
  );
}
