import { useEffect, useState } from 'react';
import { MemoryDialog, MemoryUsage } from '@/components/settings/MemoryDialog';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { readMemory, statusOf } from '@/lib/memory-api';
import type { MemoryView } from '../../../types';

type Loaded = { kind: 'loading' } | { kind: 'notSaved' } | { kind: 'failed'; message: string } | { kind: 'ready'; view: MemoryView };

const NOT_KNOWN: readonly number[] = [404, 409]; // a name the live config does not have yet, or a Hive with no config yet

const failure = (err: unknown): Loaded => {
  const status = statusOf(err);
  return status !== undefined && NOT_KNOWN.includes(status) ? { kind: 'notSaved' } : { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
};

// The memory of `workspace` (#797), only once the live config has it (`saved`): read on mount, on a new name and on window focus, so a lesson a worker saved meanwhile shows; a stale
// answer for an old name is dropped. The dialog's writes hand their answer back
function useMemoryView(workspace: string, saved: boolean): [Loaded, (view: MemoryView) => void] {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  useEffect(() => {
    if (workspace === '' || !saved) {
      setLoaded({ kind: 'notSaved' });
      return undefined;
    }
    let live = true;
    const load = (): void => {
      readMemory(workspace).then((view) => { if (live) setLoaded({ kind: 'ready', view }); }, (err: unknown) => { if (live) setLoaded(failure(err)); });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener('focus', load);
    };
  }, [workspace, saved]);
  return [loaded, (view) => setLoaded({ kind: 'ready', view })];
}

// The row's left column: the usage, or why there is none. A failed read is a passive line: the page's own alerts stay the only ones
function MemoryStatus({ loaded }: { loaded: Loaded }) {
  if (loaded.kind === 'ready') return <MemoryUsage view={loaded.view} />;
  if (loaded.kind === 'notSaved') return <p className="text-muted-foreground text-xs">{t('settings.memory.notSaved')}</p>;
  if (loaded.kind === 'failed') return <p className="text-destructive text-xs">{t('settings.memory.loadFailed', { error: loaded.message })}</p>;
  return <span />;
}

/** A workspace's memory in its card (#797): the usage only, asked only for a saved name, never a half-typed one, and `ver memória…` for the dialog. Not part of the Settings draft;
 * onCapSaved hands the dialog's total limit (#115) to the draft that carries it. */
export function MemorySection({ workspace, saved, onCapSaved }: { workspace: string; saved: boolean; onCapSaved(cap: number): void }) {
  const [loaded, setView] = useMemoryView(workspace, saved);
  const [open, setOpen] = useState(false);
  const view = loaded.kind === 'ready' ? loaded.view : undefined;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
      <MemoryStatus loaded={loaded} />
      <Button type="button" variant="outline" size="sm" disabled={view === undefined} onClick={() => setOpen(true)}>{t('settings.memory.open')}</Button>
      {view && <MemoryDialog workspace={workspace} view={view} open={open} onOpenChange={setOpen} onView={setView} onCapSaved={onCapSaved} />}
    </div>
  );
}
