import { useId, useState } from 'react';
import type { FileDiff, PrData, PrReviewFile } from '../../types';
import { prMark } from '@/components/pr-actions';
import { prSurface } from '@/components/pr-surface';
import type { CommentTarget, ReviewSurface } from '@/components/review-surface';
import { type FileNav, type LineSelect, useDiffLayout, useFileNav, useLineSelection } from '@/hooks/use-diff-pane';
import type { DiffLayout } from '@/lib/diff-rows';
import { selectedAnchor } from '@/lib/review-view';

const NO_FILES: FileDiff[] = [];

/** Everything a PR view draws beside its data (#592), as DiffView holds it for a diff: the layout, the file nav, the selection, the box, and
 * the surface once both the PR and its file are in. */
export interface PrReviewView {
  files: FileDiff[]; layout: DiffLayout; setLayout(layout: DiffLayout): void; sectionId(path: string): string; nav: FileNav; lines: LineSelect;
  target?: CommentTarget; closeBox(): void; surface?: ReviewSurface; reviewedCount: number;
}

export function usePrView(pr: PrData | undefined, review: PrReviewFile | undefined, reread: () => void, after: () => void): PrReviewView {
  const files = pr?.files ?? NO_FILES;
  const [layout, setLayout] = useDiffLayout();
  const prefix = useId();
  const sectionId = (path: string): string => `${prefix}${path}`;
  const reviewed = (file: FileDiff): boolean => review?.reviewed.some((m) => m.path === file.path && m.hash === file.hash) ?? false;
  const mark = (file: FileDiff, isReviewed: boolean): void => {
    if (pr !== undefined) void prMark(pr.url, { path: file.path, hash: file.hash, reviewed: isReviewed }).then(reread);
  };
  const nav = useFileNav({ files, sectionId, isReviewed: reviewed, mark });
  const lines = useLineSelection();
  const [editing, setEditing] = useState<CommentTarget>();
  const boxAnchor = selectedAnchor(files, lines.box);
  const target = editing ?? (boxAnchor === undefined ? undefined : { anchor: boxAnchor });
  const closeBox = (): void => { setEditing(undefined); lines.close(); };
  const edit = (next: CommentTarget): void => { lines.close(); setEditing(next); };
  const surface = pr !== undefined && review !== undefined ? prSurface({ pr, review, reviewed, mark, edit, reread, after }) : undefined;
  return { files, layout, setLayout, sectionId, nav, lines, target, closeBox, surface, reviewedCount: files.filter(reviewed).length };
}
