import type { ClipboardEvent, DOMAttributes } from 'react';
import { toast } from 'sonner';
import { act } from '@/components/actions';
import * as models from '@/lib/editor-models';

// The files tree's clipboard (#594, #818): ⌘C puts the selected files on the system pasteboard as Finder does, so they paste in Finder too;
// ⌘X does the same and keeps a cut mark, since Finder has no cut for files; ⌘V copies the pasteboard's files into a folder of the tree, or
// moves them when they are this activity's cut. The sandboxed preload has no clipboard, so main reads and writes it (window:clipboardFiles,
// window:writeClipboardFiles). The keys reach the tree as its container's DOM events, so they never compete with a terminal's.
const moveUrl = (activityId: string): string => `/activities/${encodeURIComponent(activityId)}/tree/move`; // #629

/** What tree/move answers (#594, #818). */
export interface MoveAnswer { moved: string[]; from: string[] }

/** A move the server answered (#818): each moved item's open tabs follow it to its new path, buffers kept. A copy moves nothing. */
export function followMoves(activityId: string, answer: MoveAnswer | undefined): void {
  if (answer === undefined || !Array.isArray(answer.from)) return; // a refusal (act gives undefined), or an answer with nothing to follow
  for (const [i, from] of answer.from.entries()) models.renamed(activityId, from, answer.moved[i]);
}

interface CutMark { activityId: string; absolute: string[]; relative: string[] }
let cutMark: CutMark | undefined; // ponytail: one mark per page, as the pasteboard is one per machine

const absoluteOf = (root: string, paths: readonly string[]): string[] => paths.map((path) => `${root}/${path}`);
const isSameFiles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((path) => b.includes(path));

/** Copy (#818): the files on the pasteboard by their absolute paths; without the viewer's bridge, the relative paths as text. A copy ends a
 *  cut. */
export function copyFiles(root: string, paths: readonly string[]): void {
  cutMark = undefined;
  const bridge = window.hive;
  const written = bridge === undefined ? navigator.clipboard.writeText(paths.join('\n')) : bridge.writeClipboardFiles(absoluteOf(root, paths));
  written.catch((err: Error) => toast.error(err.message));
}

/** Cut (#818): copy, then the mark the next paste in this activity reads as a move. */
export function cutFiles(activityId: string, root: string, paths: readonly string[]): void {
  copyFiles(root, paths);
  cutMark = { activityId, absolute: absoluteOf(root, paths), relative: [...paths] };
}

/** Paste (#594, #818): the pasteboard's files into `into`. This activity's cut moves, by its relative paths; anything else is copied in, the
 *  originals staying, a cut pasted in another activity included (tree/move takes an absolute source only as a copy). The mark goes either
 *  way. */
export function pasteInto(activityId: string, into: string): void {
  const bridge = window.hive;
  if (!bridge) return;
  const mark = cutMark;
  cutMark = undefined;
  void bridge.clipboardFiles().then((sources) => {
    if (sources.length === 0) return;
    const moved = mark !== undefined && mark.activityId === activityId && isSameFiles(sources, mark.absolute) ? mark.relative : undefined;
    const body = moved === undefined ? { sources, into, copy: true } : { sources: moved, into, copy: false };
    void act<MoveAnswer>(moveUrl(activityId), body).then((answer) => { if (moved !== undefined) followMoves(activityId, answer); });
  }, () => undefined); // a clipboard that cannot be read is a paste that does nothing
}

type ClipboardHandlers = Pick<DOMAttributes<HTMLElement>, 'onCut' | 'onCopy' | 'onPaste'>;

const rowPathOf = (e: ClipboardEvent): string | undefined => (e.target as Element).closest<HTMLElement>('[data-tree-path]')?.dataset.treePath;

/** The tree container's cut, copy and paste (#594, #818). Cut and copy take the focused row's selection (actedOn) once the tree knows its root;
 *  a paste lands in the focused row's folder (data-tree-folder), else the root. */
export function treeClipboard(activityId: string, root: string | undefined, selectedOf: (path: string) => string[]): ClipboardHandlers {
  const take = (e: ClipboardEvent, run: (known: string, paths: string[]) => void): void => {
    const path = rowPathOf(e);
    if (path === undefined || root === undefined) return;
    e.preventDefault(); // the files, not the page's text selection
    run(root, selectedOf(path));
  };
  return {
    onCopy: (e) => take(e, (known, paths) => copyFiles(known, paths)),
    onCut: (e) => take(e, (known, paths) => cutFiles(activityId, known, paths)),
    // No preventDefault: whether files are there is only known after the IPC, and a paste the tree ignores is harmless on a button
    onPaste: (e) => pasteInto(activityId, (e.target as Element).closest<HTMLElement>('[data-tree-folder]')?.dataset.treeFolder ?? ''),
  };
}
