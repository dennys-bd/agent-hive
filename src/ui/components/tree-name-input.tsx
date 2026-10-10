import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { t } from '@/i18n';
import { postJson } from '@/lib/api';
import * as models from '@/lib/editor-models';
import { ancestorsOf, parentOf } from '@/lib/file-tree';
import { treeChanged } from '@/lib/tree-place';

// The files tree's inline name (#818), as VS Code's explorer: a new file's or folder's at the top of its folder, or a rename in the row
// itself. Enter submits, Esc and blur cancel; a name with / makes the folders between. A refusal shows the server's words under the input,
// which stays for another try.

/** What the input edits: a new item in `folder` ('' = the root), or the rename of `path`; error: the last refusal's words. */
export type Editing = { kind: 'new'; type: 'file' | 'folder'; folder: string; error?: string } | { kind: 'rename'; path: string; error?: string };

interface NameInputProps { indent: number; initial: string; error?: string; onSubmit(name: string): void; onCancel(): void }

/** The input focused, a rename's stem (the name before its last dot) selected. A menu that opened it holds the focus until it closes, so
 *  tree-menus.tsx calls this again from its close. */
export function focusName(input: HTMLInputElement): void {
  input.focus();
  const dot = input.defaultValue.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : input.defaultValue.length);
}

/** The 24px input row, indented as the row it stands for: focused on mount. */
export function TreeNameInput({ indent, initial, error, onSubmit, onCancel }: NameInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (input === null) return;
    focusName(input);
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault(); // the detail panel's Escape skips a key a field already took
      onCancel();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const name = event.currentTarget.value.trim();
    if (name === '') onCancel();
    else onSubmit(name);
  };
  // The menu that opened the input holds the focus while it closes: a blur then is not the user leaving, and the menu hands the focus back
  const onBlur = (): void => {
    if (document.querySelector('[role="menu"]') === null) onCancel();
  };
  return (
    <div data-tree-input style={{ paddingLeft: indent }} className="flex shrink-0 flex-col pr-1.5">
      <Input
        ref={ref} defaultValue={initial} aria-label={t('files.name')} aria-invalid={error !== undefined || undefined} onKeyDown={onKeyDown} onBlur={onBlur}
        className="h-6 rounded-sm px-1.5 py-0 text-[13px] md:text-[13px]"
      />
      {error !== undefined && <p role="alert" className="px-1.5 py-0.5 text-destructive text-xs">{error}</p>}
    </div>
  );
}

interface EditingDeps { activityId: string; expand(paths: readonly string[]): void; select(path: string): void; onOpen(path: string): void }

export interface TreeEditing { editing?: Editing; start(next: Editing): void; submit(name: string): void; cancel(): void }

const joinPath = (folder: string, name: string): string => (folder === '' ? name : `${folder}/${name}`);

/** The inline input's state and its submit (#818): tree/create or tree/rename; once the server took it the item is selected and its folders
 *  open, a new file opens in the editor pane and a renamed item's open tabs follow it; a refusal stays on the input. */
export function useTreeEditing({ activityId, expand, select, onOpen }: EditingDeps): TreeEditing {
  const [editing, setEditing] = useState<Editing>();
  const isSubmitting = useRef(false); // a second Enter while the first post is out would fail on the name the first made
  const start = (next: Editing): void => {
    if (next.kind === 'new' && next.folder !== '') expand([next.folder]);
    setEditing(next);
  };
  const submit = (name: string): void => {
    if (editing === undefined || isSubmitting.current) return;
    isSubmitting.current = true;
    const [route, body]: [string, unknown] = editing.kind === 'new'
      ? ['tree/create', { path: joinPath(editing.folder, name), kind: editing.type }]
      : ['tree/rename', { from: editing.path, to: joinPath(parentOf(editing.path), name) }];
    postJson<{ path: string }>(`/activities/${encodeURIComponent(activityId)}/${route}`, body).then(({ path }) => {
      isSubmitting.current = false;
      setEditing(undefined);
      expand(ancestorsOf(path));
      select(path);
      treeChanged(activityId);
      if (editing.kind === 'rename') models.renamed(activityId, editing.path, path);
      else if (editing.type === 'file') onOpen(path);
    }, (err: Error) => {
      isSubmitting.current = false;
      // Only while the input is still the one that was submitted: a cancel or another edit since is not for this refusal to reopen
      setEditing((current) => (current === editing ? { ...editing, error: err.message } : current));
    });
  };
  return { editing, start, submit, cancel: () => setEditing(undefined) };
}
