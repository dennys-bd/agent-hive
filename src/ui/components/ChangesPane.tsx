import type { editor } from 'monaco-editor';
import { type RefObject, useEffect, useRef, useSyncExternalStore } from 'react';
import { DiskStrip, FormatFailed, type Saving, useDiskStrip, useDiskWatch, useModel, useSave } from '@/components/EditorPane';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useOpenConsole } from '@/hooks/use-console';
import { t } from '@/i18n';
import type { Activity } from '@/lib/activities';
import * as models from '@/lib/editor-models';
import * as fileBase from '@/lib/file-base';
import type { OpenDiffEditor } from '@/lib/monaco';
import type { FileBase, FormatLog } from '../../types';

type View = RefObject<editor.IStandaloneCodeEditor | undefined>;

/** label: `{task label} · Alterações {file name}`, the section's name (#668). */
export interface ChangesPaneProps { activity: Activity; path: string; label: string; active: boolean; fontFamily: string }

// The file's base from the store (#668), asked once the pane mounts; every version poll asks again (useDiskWatch)
function useBase(activityId: string, path: string): { base: FileBase | undefined; hasFailed: boolean } {
  const base = useSyncExternalStore(fileBase.subscribe, () => fileBase.baseOf(activityId, path));
  const hasFailed = useSyncExternalStore(fileBase.subscribe, () => fileBase.hasFailed(activityId, path));
  useEffect(() => {
    void fileBase.refresh(activityId, path);
  }, [activityId, path]);
  return { base, hasFailed };
}

// Monaco's diff editor (#668) once the file's model and the base's text are both there: the base on the left in a model of its own, the file's
// model from editor-models on the right. A new base text goes into the left model in place, so the view keeps its scroll. Disposed with the
// pane, the left model with it; the file's model stays in the store
function useDiffEditor(host: RefObject<HTMLDivElement | null>, view: View, model: editor.ITextModel | undefined, baseText: string | undefined, fontFamily: string, onSave: (format: boolean) => void): void {
  const latest = useRef({ onSave, fontFamily, baseText });
  useEffect(() => {
    latest.current = { onSave, fontFamily, baseText };
  });
  const original = useRef<editor.ITextModel | undefined>(undefined);
  const hasBase = baseText !== undefined;
  useEffect(() => {
    const element = host.current;
    if (model === undefined || !hasBase || element === null) return undefined;
    let open: OpenDiffEditor | undefined;
    let live = true;
    void models.loadMonaco().then(({ createDiffEditor, monaco }) => {
      if (!live) return;
      const save = (format: boolean) => (): void => latest.current.onSave(format);
      original.current = monaco.editor.createModel(latest.current.baseText ?? '', model.getLanguageId());
      open = createDiffEditor(element, original.current, model, { fontFamily: latest.current.fontFamily, onSave: save(true), onSaveUnformatted: save(false) });
      view.current = open.editor.getModifiedEditor();
    });
    return () => {
      live = false;
      open?.dispose();
      original.current?.dispose();
      original.current = undefined;
      view.current = undefined;
    };
  }, [host, view, model, hasBase]);
  useEffect(() => {
    if (baseText !== undefined && original.current !== undefined && original.current.getValue() !== baseText) original.current.setValue(baseText);
  }, [baseText]);
  useEffect(() => { view.current?.updateOptions({ fontFamily }); }, [view, fontFamily]); // a font saved in Settings (#376)
}

interface ChangesBarProps { activity: Activity; path: string; base?: FileBase; saving: Saving; onViewLog?(log: FormatLog): void }

// The bar (#668): the base selector (HEAD alone and disabled on a local activity, which has no task), the task base's label, and a save's
// refusal or a failed format as the editor's bar shows them. ⌘S and ⌥⌘S save from the right side
function ChangesBar({ activity, path, base, saving, onViewLog }: ChangesBarProps) {
  const activityId = activity.activity.id;
  const against = useSyncExternalStore(fileBase.subscribe, () => fileBase.chosenBase(activityId, path));
  const isLocal = activity.kind === 'local';
  const pick = (value: string): void => {
    if (value === 'head' || value === 'task') fileBase.choose(activityId, path, value);
  };
  return (
    <div className="flex min-h-6 shrink-0 items-center gap-2 border-b px-2.5 py-1 text-muted-foreground text-xs leading-none">
      <Select value={against} disabled={isLocal} onValueChange={pick}>
        <SelectTrigger size="sm" aria-label={t('changes.base')} className="h-6 gap-1 px-2 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="head">{t('changes.base.head')}</SelectItem>
          {!isLocal && <SelectItem value="task">{t('changes.base.task')}</SelectItem>}
        </SelectContent>
      </Select>
      {base?.against === 'task' && <span title={base.label} className="min-w-0 truncate font-mono">{base.label}</span>}
      {saving.error !== undefined && <span role="alert" className="min-w-0 truncate text-destructive">{saving.error}</span>}
      {saving.formatFailure !== undefined && <FormatFailed failure={saving.formatFailure} onViewLog={onViewLog} />}
    </div>
  );
}

/** The changes pane (#668): one file of an activity against its base in Monaco's diff editor, the base read only on the left, the file's own
 * buffer editable on the right (an edit shows in its editor pane too), its bar, and the disk strip as the editor pane has it. Its own disk
 * watch, so the strip and the base follow while only this tab shows. Collapsed like EditorPane while another tab shows; its root names its
 * file for the search's focus (#697). */
export function ChangesPane({ activity, path, label, active, fontFamily }: ChangesPaneProps) {
  const activityId = activity.activity.id;
  const file = { activityId, path };
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<editor.IStandaloneCodeEditor | undefined>(undefined);
  const load = useModel(file);
  const { base, hasFailed } = useBase(activityId, path);
  const disk = useDiskStrip(file, view);
  const saving = useSave(file, disk.setStrip, view);
  const model = load.status === 'ready' ? load.model : undefined;
  useDiffEditor(host, view, model, base?.text, fontFamily, saving.save);
  useEffect(() => { if (active) view.current?.focus(); }, [active]);
  useDiskWatch(file, active && model !== undefined, view, disk.setStrip);
  const openConsole = useOpenConsole();
  const isShown = model !== undefined && base?.text !== undefined;
  // A first ask that failed with no base held ends the wait the same way a base without text does
  const isNoBase = base === undefined ? hasFailed : base.text === undefined;
  return (
    <section aria-label={label} data-file-activity={activityId} data-file-path={path} style={{ flex: active ? '1 1 0%' : '0 0 0%', opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' }} className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <ChangesBar activity={activity} path={path} base={base} saving={saving} onViewLog={openConsole && ((log) => openConsole(log.channel, log.run, true))} />
      {disk.strip && <DiskStrip strip={disk.strip} onReload={disk.reload} onKeep={disk.keep} />}
      {load.status === 'error' && <p role="alert" className="p-3 text-destructive text-xs">{load.message}</p>}
      {load.status !== 'error' && isNoBase && <p className="p-3 text-muted-foreground text-xs">{t('changes.noBase')}</p>}
      {load.status !== 'error' && !isNoBase && !isShown && <p className="p-3 text-muted-foreground text-xs">{t('files.loading')}</p>}
      <div ref={host} hidden={!isShown} className="min-h-0 flex-1" />
    </section>
  );
}
