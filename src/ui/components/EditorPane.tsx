import type { editor } from 'monaco-editor';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { CheckerSources, ProblemsButton, ServerStatus } from '@/components/EditorStatus';
import { useEditorLanguages } from '@/components/editor-languages';
import { ProblemsList } from '@/components/ProblemsList';
import { useOpenFile } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { useOpenConsole } from '@/hooks/use-console';
import { type DiskVersion, useFileVersion } from '@/hooks/use-file-version';
import { type MessageKey, t } from '@/i18n';
import * as models from '@/lib/editor-models';
import * as fileBase from '@/lib/file-base';
import * as checks from '@/lib/check-session';
import * as lsp from '@/lib/lsp-session';
import type { OpenEditor } from '@/lib/monaco';
import type { FormatLog } from '../../types';

// The reads the pane names in its own words (#717); any other refusal shows as the server said it
const READ_ERROR: Partial<Record<number, MessageKey>> = { 404: 'editor.missing', 413: 'editor.tooLarge', 415: 'editor.binary' };

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; model: editor.ITextModel };
// What the strip says (#717): the disk holds another version than the buffer's base, or no file at all
type Strip = { kind: 'changed'; version: string } | { kind: 'missing' };
type SetStrip = (strip: Strip | undefined) => void;
type View = RefObject<editor.IStandaloneCodeEditor | undefined>;
// A save whose format failed (#749): the reason, and where its run is in the console
export interface FormatFailure { error: string; log: FormatLog }
interface File { activityId: string; path: string }

/** label: `{task label} · {file name}`, the section's name (#717). workspace: the activity's, for the language server's scope; openKey: the files
 * tree's key of the activity, what a definition in another file opens with (#780). */
export interface EditorPaneProps { activityId: string; path: string; label: string; active: boolean; fontFamily: string; workspace: string; openKey: string }

/** A refused read in the pane's own words (#717), shared with the preview pane (#697): 404, 413 and 415 named, any other as the server said. */
export function messageOf(err: unknown): string {
  if (err instanceof models.FileError) {
    const key = READ_ERROR[err.status];
    return key === undefined ? err.message : t(key);
  }
  return err instanceof Error ? err.message : String(err);
}

// The file's model from the store, read on its first open (#717), shared with the changes pane (#668)
export function useModel({ activityId, path }: File): Load {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    models.open(activityId, path).then(
      (model) => { if (live) setLoad({ status: 'ready', model }); },
      (err: unknown) => { if (live) setLoad({ status: 'error', message: messageOf(err) }); },
    );
    return () => { live = false; };
  }, [activityId, path]);
  return load;
}

// The Monaco editor over the model (#717), created once it is read, into `view`: ⌘S saves formatted and ⌥⌘S as typed (#749) through the
// latest onSave; a click's line lands through attachView; the gutter marks the file's changes (#668). Disposed with the pane; the model stays
// in the store for the next one. Shared with the untitled pane (#818)
export function useEditor(host: RefObject<HTMLDivElement | null>, view: View, load: Load, { activityId, path }: File, fontFamily: string, onSave: (format: boolean) => void): void {
  const latest = useRef({ onSave, fontFamily });
  useEffect(() => {
    latest.current = { onSave, fontFamily };
  });
  const model = load.status === 'ready' ? load.model : undefined;
  useEffect(() => {
    const element = host.current;
    if (model === undefined || element === null) return undefined;
    let open: OpenEditor | undefined;
    let detach: (() => void) | undefined;
    let unmark: (() => void) | undefined;
    let live = true;
    void models.loadMonaco().then(({ attachGutterMarks, createEditor, monaco }) => {
      if (!live) return;
      const save = (format: boolean) => (): void => latest.current.onSave(format);
      open = createEditor(element, model, { fontFamily: latest.current.fontFamily, onSave: save(true), onSaveUnformatted: save(false) });
      view.current = open.editor;
      detach = models.attachView(activityId, path, open.editor);
      unmark = models.isUntitledPath(path) ? undefined : attachGutterMarks(monaco, open.editor, { activityId, path }); // #818: no base to mark against
    });
    return () => {
      live = false;
      unmark?.();
      detach?.();
      open?.dispose();
      view.current = undefined;
    };
  }, [host, view, model, activityId, path]);
  useEffect(() => { view.current?.updateOptions({ fontFamily }); }, [view, fontFamily]); // a font saved in Settings (#376)
}

export interface Saving { save(format: boolean): void; isSaving: boolean; error?: string; formatFailure?: FormatFailure }

// salvar, ⌘S and ⌥⌘S (#717, #749): only a dirty buffer is written; a 409 raises the strip, any other refusal shows in the bar and the buffer
// stays dirty; a format that failed shows in the bar until the next save
export function useSave({ activityId, path }: File, setStrip: SetStrip, view: View): Saving {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [formatFailure, setFormatFailure] = useState<FormatFailure>();
  const save = (format: boolean): void => {
    if (isSaving || !models.isDirty(activityId, path)) return;
    setIsSaving(true);
    setError(undefined);
    setFormatFailure(undefined);
    models.save(activityId, path, format, view.current).then((result) => {
      if (result.status === 'conflict') setStrip({ kind: 'changed', version: result.version });
      else if (result.status === 'error') setError(result.message);
      else {
        setStrip(undefined);
        lsp.notifySaved(activityId, path); // #780: didSave
        checks.notifyChecksSaved(activityId, path); // #782: the command-line checkers read the saved disk
        if (result.formatError !== undefined && result.formatLog !== undefined) setFormatFailure({ error: result.formatError, log: result.formatLog });
      }
    }, (err: unknown) => setError(messageOf(err))).finally(() => setIsSaving(false));
  };
  return { save, isSaving, error, formatFailure };
}

// The disk against the buffer (#717): a clean buffer follows the disk, a dirty one raises the strip, a file gone says so and keeps the buffer.
// Each answer asks the file's base again too (#668): an agent's commit moves HEAD under the same file, and the marks follow it
export function useDiskWatch({ activityId, path }: File, isWatched: boolean, view: RefObject<editor.IStandaloneCodeEditor | undefined>, setStrip: SetStrip): void {
  useFileVersion(activityId, path, isWatched, (version: DiskVersion) => {
    void fileBase.refresh(activityId, path);
    if (version === null) setStrip({ kind: 'missing' });
    else if (version === models.baseOf(activityId, path)) setStrip(undefined);
    else if (models.isDirty(activityId, path)) setStrip({ kind: 'changed', version });
    else {
      // a read failing now leaves the buffer, the next poll tries again; typing while it flew raises the strip instead of being replaced
      models.reload(activityId, path, view.current).then((result) => { if (result.status === 'changed') setStrip({ kind: 'changed', version: result.version }); }, () => undefined);
    }
  });
}

// The file's language server (#780): attached while the pane holds the model, in the config's scope; a definition in another file opens it as
// a click in the files tree does
function useLanguageServer({ activityId, path }: File, workspace: string, openKey: string, load: Load): void {
  const { editor } = useEditorLanguages();
  const openFile = useOpenFile();
  const model = load.status === 'ready' ? load.model : undefined;
  // Keyed on the binaries that serve this file, not on the config's identity: a Settings save that changes nothing for it must not reconnect
  const binaries = lsp.attachKey(path, workspace, editor);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  useEffect(() => (model === undefined || binaries === undefined ? undefined : lsp.attach({ activityId, workspace, path, model, editor: editorRef.current })), [model, activityId, workspace, path, binaries]);
  useEffect(() => (openFile === undefined ? undefined : lsp.setOpener(activityId, (target, at) => { openFile(openKey, target, at); })), [openFile, activityId, openKey]);
}

// The file's command-line checkers (#782): attached while the pane holds the model, keyed on the checkers that run for it, so a Settings save
// that changes none of them does not run them again
function useChecks({ activityId, path }: File, workspace: string, load: Load): void {
  const { editor } = useEditorLanguages();
  const model = load.status === 'ready' ? load.model : undefined;
  const key = checks.checksKey(path, workspace, editor);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  useEffect(() => (model === undefined || key === '' ? undefined : checks.attachChecks({ activityId, workspace, path, model, editor: editorRef.current })), [model, activityId, workspace, path, key]);
}

interface BarProps { file: File; error?: string; formatFailure?: FormatFailure; isProblemsOpen: boolean; onProblems(): void; onViewLog?(log: FormatLog): void }

// formatação falhou (#749): the reason in its title; ver log opens the run in the console, and with no console (outside a Dashboard) the words stand alone
export function FormatFailed({ failure, onViewLog }: { failure: FormatFailure; onViewLog?(log: FormatLog): void }) {
  return (
    <>
      <span role="alert" title={failure.error} className="shrink-0 text-destructive">{t('editor.formatFailed')}</span>
      {onViewLog && <Button type="button" variant="link" size="xs" className="h-5 p-0 text-review" onClick={() => onViewLog(failure.log)}>{t('editor.viewLog')}</Button>}
    </>
  );
}

// The bar (#717, #780, #782): the path left; a save's refusal or a failed format (#749) in the middle; the language server and each checker
// right, then a divider and the problems button. One row 24px tall, the pane's only header (#850). ⌘S and ⌥⌘S save from the editor
function EditorBar({ file, error, formatFailure, isProblemsOpen, onProblems, onViewLog }: BarProps) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-2 border-b px-2.5 text-muted-foreground text-xs leading-none">
      <span title={file.path} className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
      {error !== undefined && <span role="alert" className="min-w-0 truncate text-destructive">{error}</span>}
      {formatFailure !== undefined && <FormatFailed failure={formatFailure} onViewLog={onViewLog} />}
      <ServerStatus activityId={file.activityId} path={file.path} onViewLog={onViewLog} />
      <CheckerSources activityId={file.activityId} path={file.path} onViewLog={onViewLog} />
      <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
      <ProblemsButton activityId={file.activityId} path={file.path} isOpen={isProblemsOpen} onToggle={onProblems} />
    </div>
  );
}

// The strip (#717): mudou no disco with recarregar and manter o meu, or arquivo não encontrado alone
export function DiskStrip({ strip, onReload, onKeep }: { strip: Strip; onReload(): void; onKeep(version: string): void }) {
  return (
    <div role="status" className="flex h-7 shrink-0 items-center gap-3 border-b px-3 text-xs">
      <span>{t(strip.kind === 'missing' ? 'editor.missing' : 'editor.changedOnDisk')}</span>
      {strip.kind === 'changed' && (
        <>
          <Button type="button" variant="link" size="xs" className="h-auto p-0 text-review" onClick={onReload}>{t('editor.reload')}</Button>
          <Button type="button" variant="link" size="xs" className="h-auto p-0 text-review" onClick={() => onKeep(strip.version)}>{t('editor.keepMine')}</Button>
        </>
      )}
    </div>
  );
}

interface DiskStripState { strip?: Strip; setStrip: SetStrip; reload(): void; keep(version: string): void }

/** The strip and its two answers (#717), shared with the changes pane (#668): recarregar takes the disk's text, typing while it flew raising
 * the strip again; manter o meu keeps the buffer on the disk's version. */
export function useDiskStrip({ activityId, path }: File, view: View): DiskStripState {
  const [strip, setStrip] = useState<Strip>();
  const reload = (): void => {
    models.reload(activityId, path, view.current).then((result) => setStrip(result.status === 'changed' ? { kind: 'changed', version: result.version } : undefined), () => undefined);
  };
  const keep = (version: string): void => {
    models.keepMine(activityId, path, version);
    setStrip(undefined);
  };
  return { strip, setStrip, reload, keep };
}

/** The editor pane (#717): one of an activity's files in Monaco, its bar, and the strip when the disk moved on. Collapsed like PtyTab while
 * another tab shows; the buffer lives in editor-models.ts, so it survives the pane. Its root names its activity and file for the search's
 * focus (#697). */
export function EditorPane({ activityId, path, label, active, fontFamily, workspace, openKey }: EditorPaneProps) {
  const file = { activityId, path };
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<editor.IStandaloneCodeEditor | undefined>(undefined);
  const load = useModel(file);
  const disk = useDiskStrip(file, view);
  const [isProblemsOpen, setProblemsOpen] = useState(false); // closed in every new pane, never persisted
  const saving = useSave(file, disk.setStrip, view);
  useEditor(host, view, load, file, fontFamily, saving.save);
  useLanguageServer(file, workspace, openKey, load);
  useChecks(file, workspace, load);
  useDiskWatch(file, active && load.status === 'ready', view, disk.setStrip);
  const openConsole = useOpenConsole();
  const openFile = useOpenFile();
  const viewLog =openConsole && ((log: FormatLog): void => openConsole(log.channel, log.run, true));
  useEffect(() => { if (active) view.current?.focus(); }, [active]);
  return (
    <section aria-label={label} data-file-activity={activityId} data-file-path={path} style={{ flex: active ? '1 1 0%' : '0 0 0%', opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' }} className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <EditorBar
        file={file} error={saving.error} formatFailure={saving.formatFailure}
        isProblemsOpen={isProblemsOpen} onProblems={() => setProblemsOpen(!isProblemsOpen)} onViewLog={viewLog}
      />
      {disk.strip && <DiskStrip strip={disk.strip} onReload={disk.reload} onKeep={disk.keep} />}
      {load.status === 'loading' && <p className="p-3 text-muted-foreground text-xs">{t('files.loading')}</p>}
      {load.status === 'error' && <p role="alert" className="p-3 text-destructive text-xs">{load.message}</p>}
      <div ref={host} hidden={load.status !== 'ready'} className="min-h-0 flex-1" />
      {isProblemsOpen && (
        <ProblemsList
          activityId={activityId} onClose={() => setProblemsOpen(false)} onViewLog={viewLog}
          onOpen={(target, at) => { if (openFile === undefined) models.revealAt(activityId, target, at); else openFile(openKey, target, at); }}
        />
      )}
    </section>
  );
}
