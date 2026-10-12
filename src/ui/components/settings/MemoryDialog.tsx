import { useEffect, useId, useState } from 'react';
import { MemoryLessons } from '@/components/settings/MemoryLessons';
import { PART_TITLE } from '@/components/settings/TaskDefaults';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { formatCount, t } from '@/i18n';
import { readMemory, readStats, saveCap } from '@/lib/memory-api';
import { isMemoryCap, memoryCapTokens } from '@/lib/memory-cap';
import { charactersText, lastText, lessonsText, statNumbers } from '@/lib/memory-view';
import { workspaceColor } from '@/lib/workspace-color';
import { MEMORY_CAP_MAX, MEMORY_CAP_MIN, type MemoryStats, type MemoryView } from '../../../types';

interface MemoryDialogProps { workspace: string; view: MemoryView; open: boolean; onOpenChange(open: boolean): void; onView(view: MemoryView): void; onCapSaved(cap: number): void }

const BLOCK = 'flex flex-col gap-3 rounded-lg border bg-card px-4 py-3.5';

/** A memory's usage (#797): the sum of its texts against the cap, its lessons and how many came from tasks; the bar turns red only at the cap. */
export function MemoryUsage({ view, medium = false }: { view: MemoryView; medium?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className={medium ? 'font-medium text-sm' : 'text-sm'}>{charactersText(view.used, view.cap)}</span>
        <span className="text-muted-foreground text-xs">{lessonsText(view.entries)}</span>
      </div>
      <Progress aria-label={t('settings.memory.progress')} value={Math.min(100, (view.used / view.cap) * 100)} indicatorClassName={view.used >= view.cap ? 'bg-destructive' : undefined} />
    </div>
  );
}

// The stats, read when the dialog opens and on window focus while it is open
function useMemoryStats(workspace: string, open: boolean): MemoryStats | undefined {
  const [stats, setStats] = useState<MemoryStats>();
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    const load = (): void => {
      readStats(workspace).then((read) => { if (live) setStats(read); }, () => { if (live) setStats(undefined); });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener('focus', load);
    };
  }, [workspace, open]);
  return stats;
}

interface CapFieldProps { workspace: string; view: MemoryView; onCapSaved(cap: number): void; onView(view: MemoryView): void }

// #115: the route's own range refusal in the user's language; any other failure is not the user's to fix, so the server's words are never shown
const capErrorText = (err: unknown): string => t((err as { code?: unknown } | null)?.code === 'cap_range' ? 'settings.memory.capRange' : 'settings.memory.capFailed');

// #115: the total limit, saved at once through PUT …/memory/cap like every edit in this dialog, never the Settings draft. Save (or Enter) only
// for a valid value other than the saved one, so a number typed key by key is never written midway. Under the field what a full memory
// costs per run, or the range; then a failed save's reason
function CapField({ workspace, view, onCapSaved, onView }: CapFieldProps) {
  const id = useId();
  const { cap } = view;
  const [text, setText] = useState(String(cap));
  const [error, setError] = useState<string>();
  const valid = isMemoryCap(text);
  const next = Number(text.trim());
  const canSave = valid && next !== cap;
  const save = (): void => {
    if (!canSave) return;
    saveCap(workspace, next).then(
      () => {
        onCapSaved(next); // in the file now: the Settings draft and its baseline take it whatever the read below does
        // the save stands even if the read fails: the bars take the new cap now, the next focus read the rest
        readMemory(workspace).then(onView, () => onView({ ...view, cap: next }));
      },
      (err: unknown) => setError(capErrorText(err)),
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="font-normal text-muted-foreground text-xs">{t('settings.memory.totalLimit')}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id} type="number" min={MEMORY_CAP_MIN} max={MEMORY_CAP_MAX} step={1} value={text} aria-invalid={!valid || error !== undefined} aria-describedby={`${id}-note`}
          onChange={(e) => { setText(e.target.value); setError(undefined); }}
          // a key an IME composition sends confirms its candidate, it is not the user's save
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); save(); } }}
        />
        <Button type="button" size="sm" disabled={!canSave} onClick={save}>{t('settings.memory.save')}</Button>
      </div>
      <span id={`${id}-note`} className={valid ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}>
        {valid ? t('settings.memory.capEstimate', { n: formatCount(memoryCapTokens(next)) }) : t('settings.memory.capRange')}
      </span>
      {error !== undefined && <p role="alert" className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

interface UsageBlockProps { workspace: string; view: MemoryView; onCapSaved(cap: number): void; onView(view: MemoryView): void }

// The limits: the total as a field saved at once (#115), the per-lesson one fixed and shown off until its entry in
// docs/agent/settings-candidates.md makes it a setting
function UsageBlock({ workspace, view, onCapSaved, onView }: UsageBlockProps) {
  const id = useId();
  return (
    <section aria-label={t('settings.memory.usage')} className={BLOCK}>
      <h3 className={PART_TITLE}>{t('settings.memory.usage')}</h3>
      <MemoryUsage view={view} medium />
      <div className="grid grid-cols-2 items-start gap-3">
        {/* keyed by the saved cap: a new one (this field's save, or a read on focus) resets what is typed */}
        <CapField key={view.cap} workspace={workspace} view={view} onCapSaved={onCapSaved} onView={onView} />
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-max`} className="font-normal text-muted-foreground text-xs">{t('settings.memory.lessonLimit')}</Label>
          <Input id={`${id}-max`} type="number" value={view.textMax} readOnly disabled />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{t('settings.memory.limitNote')}</p>
    </section>
  );
}

// The last 7 days of the local event log; dashes without a run carrying memory
function TelemetryBlock({ stats, total }: { stats?: MemoryStats; total: number }) {
  const numbers = statNumbers(stats, total);
  const cells = [[numbers.runs, 'settings.memory.runs'], [numbers.cited, 'settings.memory.cited'], [numbers.tokens, 'settings.memory.tokens']] as const;
  return (
    <section aria-label={t('settings.memory.telemetry')} className={BLOCK}>
      <h3 className={PART_TITLE}>{t('settings.memory.telemetry')}</h3>
      <dl className="grid grid-cols-3 gap-3">
        {cells.map(([value, label]) => (
          <div key={label} className="flex flex-col-reverse">
            <dt className="text-muted-foreground text-xs">{t(label)}</dt>
            <dd className="font-semibold text-lg leading-6">{value}</dd>
          </div>
        ))}
      </dl>
      {stats?.last && <p className="text-muted-foreground text-xs">{lastText(stats.last, Date.now())}</p>}
      <p className="text-muted-foreground text-xs">{t('settings.memory.telemetryNote')}</p>
    </section>
  );
}

function RulesBlock() {
  const rules = [['settings.memory.ruleIn', 'settings.memory.ruleInText'], ['settings.memory.ruleOut', 'settings.memory.ruleOutText']] as const;
  return (
    <div className="grid grid-cols-2 gap-4">
      {rules.map(([title, text]) => (
        <div key={title} className="flex flex-col gap-2">
          <h3 className={PART_TITLE}>{t(title)}</h3>
          <p className="text-muted-foreground text-xs">{t(text)}</p>
        </div>
      ))}
    </div>
  );
}

/** A workspace's memory (#797): what its agents know before they start, its usage, its last 7 days and its lessons. Every edit is saved at
 * once through the memory routes, never the Settings draft: workers write the same file at any moment. The total limit (#115) is saved the same way,
 * into hive.config.json, and handed up so the Settings draft keeps it. */
export function MemoryDialog({ workspace, view, open, onOpenChange, onView, onCapSaved }: MemoryDialogProps) {
  const stats = useMemoryStats(workspace, open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" showCloseButton={false} className="gap-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: workspaceColor(workspace) }} />
            {t('settings.memory.title', { workspace })}
          </DialogTitle>
          <DialogDescription className="text-xs">{t('settings.memory.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
          <UsageBlock workspace={workspace} view={view} onCapSaved={onCapSaved} onView={onView} />
          <TelemetryBlock stats={stats} total={view.entries.length} />
        </div>
        <MemoryLessons workspace={workspace} view={view} onView={onView} />
        <RulesBlock />
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="outline">{t('settings.memory.close')}</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
