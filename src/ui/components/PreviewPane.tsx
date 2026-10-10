import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DocMarkdown } from '@/components/DocMarkdown';
import { messageOf } from '@/components/EditorPane';
import { useOpenFile } from '@/components/terminal-tabs';
import { useFileVersion } from '@/hooks/use-file-version';
import { t } from '@/i18n';
import { type Activity, activityKey } from '@/lib/activities';
import { fileRefPath } from '@/lib/center-layout';
import { docLink } from '@/lib/doc-links';
import * as models from '@/lib/editor-models';

type Read = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; text: string; version?: string };

/** label: `{task label} · Preview {file name}`, the section's name (#697). */
export interface PreviewPaneProps { activity: Activity; path: string; label: string; active: boolean }

const PREVIEW = { preview: true } as const;
// An anchor a link in another preview asked for (#697), kept by `<activity id>:<path>` until that file's pane shows its document, which
// takes it on first use; an open that fails or a file that cannot be read drops it. ponytail: module state, one entry per file at most and
// none while the pane is mounted; an entry whose tab never mounts nor fails stays until the page reloads, add an expiry if that ever shows
const pendingAnchors = new Map<string, string>();
// The mounted pane of a key, told at once when a link asks it for an anchor (#697): its document is already on screen
const waiters = new Map<string, () => void>();
const anchorKey = (activityId: string, path: string): string => `${activityId}:${path}`;

function askAnchor(key: string, anchor: string): void {
  pendingAnchors.set(key, anchor);
  waiters.get(key)?.();
}

// The element of the document with that id or name, else the one the sanitizer prefixed: raw HTML's ids and names carry user-content- (#697).
// Compared as attributes, never put in a selector
function anchorIn(root: HTMLElement | null, id: string): Element | undefined {
  const elements = [...(root?.querySelectorAll('[id], [name]') ?? [])];
  const found = (attribute: string, value: string): Element | undefined => elements.find((element) => element.getAttribute(attribute) === value);
  return found('id', id) ?? found('name', id) ?? found('id', `user-content-${id}`) ?? found('name', `user-content-${id}`);
}
const scrollTo = (root: HTMLElement | null, id: string): void => anchorIn(root, id)?.scrollIntoView({ block: 'start' });
// The task's GitHub repository, for DocMarkdown's #N and @user links (#697); a local activity has none
const repositoryOf = (activity: Activity): string | undefined => (activity.kind === 'task' ? activity.task.item.facets?.repository : undefined);

// The disk's text (#697), read again whenever the poll finds another version; idle while an editor buffer holds the file
function useDiskText(activityId: string, path: string, isWatched: boolean, isBuffered: boolean): Read {
  const [read, setRead] = useState<Read>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is the trigger of a new read, not a value it uses
  useEffect(() => {
    if (isBuffered) {
      setRead({ status: 'loading' }); // the disk's text may be older than the edits that ends with the buffer: show nothing until a fresh read
      return undefined;
    }
    let live = true;
    models.readFile(activityId, path).then(
      (file) => { if (live) setRead({ status: 'ready', text: file.text, version: file.version }); },
      (err: unknown) => { if (live) setRead({ status: 'error', message: messageOf(err) }); },
    );
    return () => { live = false; };
  }, [activityId, path, isBuffered, reads]);
  const version = read.status === 'ready' ? read.version : undefined;
  useFileVersion(activityId, path, isWatched && !isBuffered, (next) => {
    if (next !== version) setReads((n) => n + 1); // a file gone (null) reads again too: the read's 404 says so
  });
  return read;
}

// What the pane renders (#697): the editor buffer's text while one holds the file, unsaved edits live, else the disk's; an editor tab opened
// or closed on the file switches the source in place. ponytail: the whole document renders again per keystroke, fine up to the 1 MB cap;
// debounce the buffer's text if it lags
function usePreviewText(activityId: string, path: string, isShown: boolean): Read {
  const buffered = useSyncExternalStore(models.subscribe, () => models.textOf(activityId, path));
  const disk = useDiskText(activityId, path, isShown, buffered !== undefined);
  return buffered === undefined ? disk : { status: 'ready', text: buffered };
}

// A link's click (#697): an anchor scrolls this pane; a file opens through the dock's opener, a markdown one as its preview with its anchor
// kept for that pane; anything else does nothing
function useLinks(activity: Activity, path: string, scroller: RefObject<HTMLDivElement | null>): (href: string) => void {
  const openFile = useOpenFile();
  return (href) => {
    const link = docLink(href, path);
    if (link.kind === 'anchor') return scrollTo(scroller.current, link.id);
    if (link.kind !== 'file') return;
    const ref = fileRefPath(link.path, activity.activity.worktree);
    if (ref === path && link.anchor !== undefined) return scrollTo(scroller.current, link.anchor);
    if (ref !== undefined && link.isMarkdown && link.anchor !== undefined) askAnchor(anchorKey(activity.activity.id, ref), link.anchor);
    const isOpen = openFile?.(activityKey(activity), link.path, undefined, link.isMarkdown ? PREVIEW : undefined) ?? false;
    if (!isOpen && ref !== undefined) pendingAnchors.delete(anchorKey(activity.activity.id, ref));
  };
}

// The anchor another preview's link asked for, scrolled to once this pane shows its document, at once when it already does (#697). A document
// that cannot be read drops it
function usePendingAnchor(activityId: string, path: string, isReady: boolean, hasFailed: boolean, scroller: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const key = anchorKey(activityId, path);
    if (hasFailed) pendingAnchors.delete(key);
    if (!isReady) return undefined;
    const take = (): void => {
      const anchor = pendingAnchors.get(key);
      if (anchor === undefined) return;
      pendingAnchors.delete(key);
      scrollTo(scroller.current, anchor);
    };
    take();
    waiters.set(key, take);
    return () => { if (waiters.get(key) === take) waiters.delete(key); };
  }, [activityId, path, isReady, hasFailed, scroller]);
}

/** The preview pane (#697): one markdown file of an activity, rendered and read only, as VS Code's Markdown: Open Preview. The group's
 * PaneHeader reads Preview and the path; the pane's own bar shows the path. Collapsed like EditorPane while another tab
 * shows. */
export function PreviewPane({ activity, path, label, active }: PreviewPaneProps) {
  const activityId = activity.activity.id;
  const scroller = useRef<HTMLDivElement>(null);
  const read = usePreviewText(activityId, path, active);
  const onLink = useLinks(activity, path, scroller);
  usePendingAnchor(activityId, path, active && read.status === 'ready', read.status === 'error', scroller);
  return (
    <section aria-label={label} style={{ flex: active ? '1 1 0%' : '0 0 0%', opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' }} className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-muted-foreground text-xs">
        <span title={path} className="min-w-0 flex-1 truncate font-mono">{path}</span>
      </div>
      {read.status === 'loading' && <p className="p-3 text-muted-foreground text-xs">{t('files.loading')}</p>}
      {read.status === 'error' && <p role="alert" className="p-3 text-destructive text-xs">{read.message}</p>}
      {read.status === 'ready' && (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-6 py-4">
          <DocMarkdown text={read.text} repository={repositoryOf(activity)} onLink={onLink} />
        </div>
      )}
    </section>
  );
}
