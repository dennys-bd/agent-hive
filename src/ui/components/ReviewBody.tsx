import type { KeyboardEvent, ReactNode } from 'react';
import { matches } from '../../shortcuts';
import type { FileDiff } from '../../types';
import { DiffFile } from '@/components/DiffFile';
import { DiffFileList } from '@/components/DiffFileList';
import { DiffFooter, SUBMIT_KEY } from '@/components/DiffFooter';
import { type CommentTarget, useReviewSurface } from '@/components/review-surface';
import { type FileNav, type LineSelect, type PaneKey, paneKey } from '@/hooks/use-diff-pane';
import type { DiffLayout } from '@/lib/diff-rows';
import { isMac } from '@/lib/shortcut-bindings';

interface ReviewBodyProps {
  files: FileDiff[]; layout: DiffLayout; nav: FileNav; sectionId(path: string): string; lines: LineSelect; target?: CommentTarget; onCloseBox(): void;
  top?: ReactNode; // above the first file: the PR page's fora do diff (#592)
}

/** A review pane's body (#591, #592): the file list, every file's section, then the footer unless read only; the pane keys (], [, C, V, ⌘⇧↵). */
export function ReviewBody({ files, layout, nav, sectionId, lines, target, onCloseBox, top }: ReviewBodyProps) {
  const surface = useReviewSurface();
  const actions: Partial<Record<PaneKey, () => void>> = {
    comment: () => { if (!surface.readOnly) lines.comment(); },
    next: () => nav.step(1),
    previous: () => nav.step(-1),
    reviewed: () => {
      const file = nav.shown.find((f) => f.path === nav.open);
      if (file) nav.toggleReviewed(file);
    },
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // React bubbles a portal's keys through the tree: a menu's typeahead (the scope picker, a session picker) is not the pane's
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (matches(event.nativeEvent, SUBMIT_KEY, isMac())) { event.preventDefault(); surface.submit?.submit(); return; }
    const key = paneKey(event.nativeEvent);
    const action = key === undefined ? undefined : actions[key];
    if (action === undefined) return;
    event.preventDefault();
    action();
  };
  // A file's pill (#591): its drafts and its conversations
  const comments = (path: string): number => {
    const file = files.find((f) => f.path === path);
    return surface.drafts(path).length + (file === undefined ? 0 : surface.conversations(file).length);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the pane's keys (], [, V) are a viewer's habit, a delegated handler on the pane, not a widget (#591)
    <div className="flex min-h-0 flex-1 flex-col outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="flex min-h-0 flex-1">
        {/* Every file, whatever ocultar revisados says: the list is the diff's map (#591) */}
        <DiffFileList files={files} open={nav.open} isReviewed={surface.reviewed} onOpen={nav.show} comments={comments} />
        {/* the files as cards, 16px around and 12px between (#853) */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto p-4">
          {top}
          {nav.shown.map((file) => (
            <DiffFile
              key={file.path} file={file} id={sectionId(file.path)} layout={layout} collapsed={nav.collapsed.has(file.path)}
              isReviewed={surface.reviewed(file)} onToggle={() => nav.toggle(file.path)} onReviewed={() => nav.toggleReviewed(file)}
              lines={lines} target={target} onCloseBox={onCloseBox}
            />
          ))}
        </div>
      </div>
      {!surface.readOnly && <DiffFooter />}
    </div>
  );
}
