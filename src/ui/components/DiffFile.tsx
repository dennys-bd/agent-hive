import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DiffLine, FileDiff, LineAnchor } from '../../types';
import { CommentBox } from '@/components/CommentBox';
import { Conversation } from '@/components/Conversation';
import { DiffCols, type HunkView, HunkRows } from '@/components/DiffLines';
import { BOX } from '@/components/review-context';
import { type CommentTarget, useReviewSurface } from '@/components/review-surface';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import type { LineSelect, LineSelection } from '@/hooks/use-diff-pane';
import { type Counts, countsOf, type DiffLayout, splitPath } from '@/lib/diff-rows';
import { endsAt } from '@/lib/review-view';
import type { SurfaceDraft } from '@/lib/surface';

/** `+a −d` with each sign in its status colour (#591): a file's, a row's and the bar's. A zero side is left out (#853); className sizes it. */
export function CountsText({ counts, className = 'font-mono' }: { counts: Counts; className?: string }) {
  return (
    <span className={`tabular-nums ${className}`}>
      {counts.add > 0 && <span className="text-working">+{counts.add}</span>}
      {counts.add > 0 && counts.del > 0 && ' '}
      {counts.del > 0 && <span className="text-destructive">−{counts.del}</span>}
    </span>
  );
}

/** A file's name as its header shows it (#270): `old → new` on a rename. */
export const filePath = (file: FileDiff): string => (file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`);

// Whether a line has a number on a side: side by side, the half a selection was begun in is the only one it takes
const isOnSide = (line: DiffLine | undefined, side?: 'old' | 'new'): boolean => side === undefined || line?.[side] !== undefined;

// The pane's selection as one hunk's view (#591), and what shows under its lines. Side by side, a click or a drag belongs to the half of its
// +: the old one only on a deleted line. A read-only pane draws no + (#592)
function hunkView(file: FileDiff, hunk: number, layout: DiffLayout, lines: LineSelect, below: (line: DiffLine) => ReactNode, canComment: boolean): HunkView {
  const hunkLines = file.hunks[hunk]?.lines ?? [];
  const sideOf = (index: number) => (layout === 'unified' ? {} : { side: hunkLines[index]?.kind === 'del' ? 'old' as const : 'new' as const });
  const at = (index: number): LineSelection => ({ path: file.path, hunk, from: index, to: index, start: index, ...sideOf(index) });
  const sel = lines.selection;
  const isHere = sel?.path === file.path && sel.hunk === hunk;
  return {
    canComment,
    range: isHere ? { from: sel.from, to: sel.to, start: sel.start } : undefined,
    // The start line keeps its + until the comment ends, the selection's mark where the bar is not. While a drag runs no other line shows
    // one: the pointer passing over them extends the bar, not the +
    plus: (index) => {
      if (isHere && index === sel.start) return 'shown';
      return lines.isDragging ? 'hidden' : 'hover';
    },
    select: (index) => lines.select(at(index)),
    begin: (index) => lines.begin(at(index)),
    extend: (index) => { if (isOnSide(hunkLines[index], sel?.side)) lines.extend(file.path, hunk, index); },
    below,
  };
}

// A draft on its line (#591): its text, na revisão, and editar, which opens the box on it; a read-only pane offers no editar (#592)
function DraftNote({ draft }: { draft: SurfaceDraft }) {
  const surface = useReviewSurface();
  return (
    <div className={`${BOX} flex items-start gap-2`}>
      <span className="min-w-0 flex-1 whitespace-pre-wrap">{draft.text}</span>
      <span className="rounded-md border px-1.5 text-waiting text-xs">{t('review.inReview')}</span>
      {!surface.readOnly && (
        <button type="button" className="text-muted-foreground text-xs hover:underline" onClick={() => surface.edit({ anchor: draft.anchor, draft })}>{t('review.edit')}</button>
      )}
    </div>
  );
}

// The path as the card's header shows it (#853): the folder muted, the name semibold; a rename keeps `old → new` whole, as before
function FileName({ file }: { file: FileDiff }) {
  if (file.oldPath !== undefined) return <span className="min-w-0 truncate">{filePath(file)}</span>;
  const { dir, name } = splitPath(file.path);
  return <span className="min-w-0 truncate"><span className="text-muted-foreground">{dir}</span><span className="font-semibold">{name}</span></span>;
}

// revisado's 12px square (#853): empty on the empty token's border, or filled muted-foreground with a ✓
const CHECK = 'flex size-3 shrink-0 items-center justify-center rounded-[3px] text-[10px] leading-none';
function ReviewedCheck({ isOn }: { isOn: boolean }) {
  return <span aria-hidden="true" data-slot="reviewed-check" className={`${CHECK} ${isOn ? 'bg-muted-foreground text-background' : 'border border-empty'}`}>{isOn ? '✓' : ''}</span>;
}

interface FileHeaderProps { file: FileDiff; collapsed: boolean; isReviewed: boolean; onToggle(): void; onReviewed(): void }

// A card's 40px header (#853): chevron, path, counts, abrir arquivo in ring when the pane has it, revisado with its square and V
function FileHeader({ file, collapsed, isReviewed, onToggle, onReviewed }: FileHeaderProps) {
  const surface = useReviewSurface();
  return (
    <header className={`sticky top-0 z-10 flex h-10 items-center gap-2.5 bg-card px-3.5 text-[13px] ${collapsed ? '' : 'border-b'}`}>
      <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" aria-expanded={!collapsed} aria-label={t(collapsed ? 'diff.expand' : 'diff.collapse')} onClick={onToggle}>
        {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
      </Button>
      <FileName file={file} />
      {file.binary ? <span className="text-muted-foreground text-xs">{t('diff.binary')}</span> : <CountsText counts={countsOf(file.hunks)} className="text-xs" />}
      <span className="ml-auto flex items-center gap-2.5">
        {file.status !== 'deleted' && surface.openFile !== undefined && (
          <button type="button" className="text-ring text-xs hover:underline" onClick={() => surface.openFile?.(file)}>{t('diff.openFile')}</button>
        )}
        <Button type="button" size="xs" variant="outline" aria-pressed={isReviewed} onClick={onReviewed}>
          <ReviewedCheck isOn={isReviewed} />{t('diff.reviewed')}<span aria-hidden="true" className="font-normal text-muted-foreground">V</span>
        </Button>
      </span>
    </header>
  );
}

interface DiffFileProps {
  file: FileDiff; id: string; layout: DiffLayout; collapsed: boolean; isReviewed: boolean; onToggle(): void; onReviewed(): void;
  lines: LineSelect; target?: CommentTarget; onCloseBox(): void;
}

/** One file of a review pane as a card (#591, #592, #853): its 40px header, then at its top what lost its lines and GitHub's file conversations, then its hunks unless collapsed or binary. */
export function DiffFile({ file, id, layout, collapsed, isReviewed, onToggle, onReviewed, lines, target, onCloseBox }: DiffFileProps) {
  const surface = useReviewSurface();
  const conversations = surface.conversations(file);
  const top = conversations.filter((c) => c.outdated || c.fileLevel === true);
  const placed = conversations.filter((c) => !top.includes(c));
  const drafts = surface.drafts(file.path).filter((draft) => target?.draft?.id !== draft.id); // the one in the box shows there
  // Side by side, a half shows only what is anchored on its side (#591)
  const below = (line: DiffLine, side?: 'old' | 'new'): ReactNode => {
    const isAt = (anchor: Pick<LineAnchor, 'side' | 'end'>): boolean => (side === undefined || anchor.side === side) && endsAt(anchor, line);
    const here = placed.filter((c) => isAt(c.anchor));
    const hereDrafts = drafts.filter((draft) => isAt(draft.anchor));
    const isBox = target !== undefined && target.anchor.path === file.path && isAt(target.anchor);
    if (here.length === 0 && hereDrafts.length === 0 && !isBox) return null;
    return (
      <>
        {hereDrafts.map((draft) => <DraftNote key={draft.id} draft={draft} />)}
        {here.map((c) => <Conversation key={c.id} conversation={c} />)}
        {isBox && <CommentBox key={`${target.anchor.side}${target.anchor.start}-${target.anchor.end}`} target={target} onClose={onCloseBox} />}
      </>
    );
  };
  return (
    <section id={id} aria-label={file.path} className="shrink-0 overflow-clip rounded-lg border">
      <FileHeader file={file} collapsed={collapsed} isReviewed={isReviewed} onToggle={onToggle} onReviewed={onReviewed} />
      {!collapsed && top.map((c) => <div key={c.id} className="px-2"><Conversation conversation={c} isOutdated={c.outdated} /></div>)}
      {!collapsed && !file.binary && (
        <table className="w-full table-fixed border-collapse font-mono text-xs leading-[22px]">
          <DiffCols layout={layout} />
          <tbody>{file.hunks.map((hunk, index) => <HunkRows key={hunk.header} hunk={hunk} layout={layout} view={hunkView(file, index, layout, lines, below, !surface.readOnly)} />)}</tbody>
        </table>
      )}
    </section>
  );
}
