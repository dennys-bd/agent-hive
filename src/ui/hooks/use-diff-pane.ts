import { useEffect, useState } from 'react';
import type { FileDiff } from '../../types';
import type { DiffLayout } from '@/lib/diff-rows';

/** Unified or side by side (#591): a viewer's habit, kept like hive.splitEdge (#536), never a setting. */
export const DIFF_LAYOUT_KEY = 'hive.diffLayout';
const readLayout = (): DiffLayout => (localStorage.getItem(DIFF_LAYOUT_KEY) === 'split' ? 'split' : 'unified');

export function useDiffLayout(): [DiffLayout, (layout: DiffLayout) => void] {
  const [layout, setLayout] = useState<DiffLayout>(readLayout);
  return [layout, (next) => { localStorage.setItem(DIFF_LAYOUT_KEY, next); setLayout(next); }];
}

const withMember = (set: ReadonlySet<string>, key: string, isIn: boolean): ReadonlySet<string> => {
  const next = new Set(set);
  if (isIn) next.add(key);
  else next.delete(key);
  return next;
};

/** Which file is open, which sections are collapsed, and the reviewed sections hidden or not (#591): `shown` is the main column's files. */
export interface FileNav {
  open?: string; collapsed: ReadonlySet<string>; hideReviewed: boolean; shown: FileDiff[];
  show(path: string): void; toggle(path: string): void; setHideReviewed(hide: boolean): void; step(delta: 1 | -1): void; toggleReviewed(file: FileDiff): void;
}

interface NavInput { files: FileDiff[]; sectionId(path: string): string; isReviewed(file: FileDiff): boolean; mark(file: FileDiff, reviewed: boolean): void }

/** The next file after `path` that is not reviewed, wrapping to the top (#591); undefined when every other one is. */
export function nextUnreviewed(files: FileDiff[], path: string, isReviewed: (file: FileDiff) => boolean): string | undefined {
  const at = files.findIndex((f) => f.path === path);
  return [...files.slice(at + 1), ...files.slice(0, Math.max(at, 0))].find((f) => !isReviewed(f))?.path;
}

export function useFileNav({ files, sectionId, isReviewed, mark }: NavInput): FileNav {
  const [open, setOpen] = useState<string>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [hideReviewed, setHideReviewed] = useState(false);
  const shown = hideReviewed ? files.filter((f) => !isReviewed(f)) : files;
  const current = open !== undefined && shown.some((f) => f.path === open) ? open : shown[0]?.path;
  const show = (path: string): void => {
    setOpen(path);
    document.getElementById(sectionId(path))?.scrollIntoView?.({ block: 'start' }); // jsdom has none
  };
  const fold = (path: string, isFolded: boolean): void => setCollapsed((set) => withMember(set, path, isFolded));
  return {
    open: current, collapsed, hideReviewed, shown, show, setHideReviewed,
    toggle: (path) => fold(path, !collapsed.has(path)),
    step: (delta) => {
      const at = shown.findIndex((f) => f.path === current);
      const next = shown[(at + delta + shown.length) % shown.length];
      if (next) show(next.path);
    },
    // Marked: the section folds and the next unreviewed file opens; unmarked: it opens again (#591)
    toggleReviewed: (file) => {
      const reviewed = !isReviewed(file);
      mark(file, reviewed);
      fold(file.path, reviewed);
      const next = reviewed ? nextUnreviewed(files, file.path, isReviewed) : undefined;
      if (next !== undefined) show(next);
    },
  };
}

/** The pane's fixed keys (#591), like the terminal's own: not OperationId entries, they mean nothing outside the pane. */
export type PaneKey = 'next' | 'previous' | 'reviewed' | 'comment';
const PANE_KEYS: Partial<Record<string, PaneKey>> = { ']': 'next', '[': 'previous', v: 'reviewed', c: 'comment' };
const TEXT_FIELD = 'textarea, input:not([type="checkbox"])';

/** A keydown as a pane key, or undefined: with a modifier, or while a text field has the focus. */
export function paneKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>): PaneKey | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  if (event.target instanceof Element && event.target.closest(TEXT_FIELD) !== null) return undefined;
  return PANE_KEYS[event.key.toLowerCase()];
}

/** Lines of one hunk of one file, by their index in the hunk (#591); `start` is the line the + sits on, where a click or a drag began.
 * Side by side, `side` is the half it began in, the only one it takes lines from. */
export interface LineSelection { path: string; hunk: number; from: number; to: number; start: number; side?: 'old' | 'new' }
export interface LineSelect {
  selection?: LineSelection; box?: LineSelection;
  isDragging: boolean;
  select(selection: LineSelection): void; // a click on a line
  begin(selection: LineSelection): void; // pointer down on its +
  extend(path: string, hunk: number, index: number): void; // the pointer over a line while dragging: same file and hunk only
  comment(): void; // C: the box on the selection
  close(): void; // Esc, cancelar or a sent comment: the selection goes with the box, so no bar outlives it
}

export function useLineSelection(): LineSelect {
  const [selection, setSelection] = useState<LineSelection>();
  const [isDragging, setDragging] = useState(false);
  const [box, setBox] = useState<LineSelection>();
  useEffect(() => { // the drag ends wherever the pointer is let go: the box opens on what it selected
    if (!isDragging) return undefined;
    const up = (): void => { setDragging(false); setBox(selection); };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [isDragging, selection]);
  return {
    selection, box, isDragging,
    select: setSelection,
    begin: (next) => { setSelection(next); setDragging(true); },
    extend: (path, hunk, index) => {
      if (!isDragging || selection?.path !== path || selection.hunk !== hunk) return;
      const { start } = selection;
      setSelection({ ...selection, from: Math.min(start, index), to: Math.max(start, index) });
    },
    comment: () => setBox(selection),
    close: () => { setBox(undefined); setSelection(undefined); },
  };
}
