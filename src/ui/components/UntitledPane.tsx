import type { editor } from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { useEditor, useModel } from '@/components/EditorPane';
import { t } from '@/i18n';
import * as models from '@/lib/editor-models';
import { saveUntitled } from '@/lib/untitled-save';

export interface UntitledPaneProps { activityId: string; n: number; active: boolean; fontFamily: string; onSaved(path: string): void }

/** An untitled file (#818): the +'s file item, a buffer with no file behind it. ⌘S (and ⌥⌘S) asks the OS where to save it; once the server
 *  wrote it, onSaved turns the tab into the file's. Collapsed like EditorPane while another tab shows. */
export function UntitledPane({ activityId, n, active, fontFamily, onSaved }: UntitledPaneProps) {
  const file = { activityId, path: models.untitledPath(n) };
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<editor.IStandaloneCodeEditor | undefined>(undefined);
  const load = useModel(file);
  const [isSaving, setIsSaving] = useState(false);
  const save = (): void => {
    if (isSaving) return;
    setIsSaving(true);
    void saveUntitled(activityId, n).then((path) => { if (path !== undefined) onSaved(path); }).finally(() => setIsSaving(false));
  };
  useEditor(host, view, load, file, fontFamily, save);
  useEffect(() => { if (active) view.current?.focus(); }, [active]);
  const name = t('editor.untitled', { n });
  return (
    <section aria-label={name} style={{ flex: active ? '1 1 0%' : '0 0 0%', opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' }} className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex min-h-6 shrink-0 items-center border-b px-2.5 py-1 text-muted-foreground text-xs leading-none"><span className="truncate font-mono">{name}</span></div>
      {load.status === 'loading' && <p className="p-3 text-muted-foreground text-xs">{t('files.loading')}</p>}
      <div ref={host} hidden={load.status !== 'ready'} className="min-h-0 flex-1" />
    </section>
  );
}
