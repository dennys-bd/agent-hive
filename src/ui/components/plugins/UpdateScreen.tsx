import { useCallback } from 'react';
import type { CatalogueItem, UpdateChoice, UpdateConflict, UpdatePreview } from '../../../types';
import { HeaderSlot } from '@/components/HeaderSlot';
import { UpdateHead } from '@/components/plugins/PluginsHead';
import { ConflictBlock } from '@/components/plugins/UpdateConflict';
import { Button } from '@/components/ui/button';
import type { Plugins } from '@/hooks/use-plugins';
import { useUpdate } from '@/hooks/use-update';
import { type MessageKey, t, tPlural } from '@/i18n';
import { sideAgainstBase } from '@/lib/update-diff';

type Change = UpdatePreview['changes'][number];
type Choices = Readonly<Record<string, UpdateChoice>>;
const isConflict = (change: Change): change is UpdateConflict => change.kind === 'conflict';
const CHOICE_LABEL: Record<UpdateChoice, MessageKey> = { mine: 'plugins.update.keepMine', hive: 'plugins.update.useHive' };
// mark, heading, file, line counts, status
const COLUMNS = 'grid grid-cols-[12px_minmax(0,1fr)_minmax(0,1fr)_72px_140px] items-center gap-3';

// decision 6: each count's sentence, a zero one left out
function summaryOf(changes: readonly Change[]): string {
  const conflicts = changes.filter(isConflict).length;
  const clean = changes.length - conflicts;
  const parts = [clean > 0 ? tPlural('plugins.update.clean', clean, { n: clean }) : '', conflicts > 0 ? tPlural('plugins.update.passages', conflicts, { n: conflicts }) : ''];
  const sentence = parts.filter((part) => part !== '').join('; ');
  return sentence === '' ? '' : `${sentence}.`;
}

// A clean change's own counts; a conflict's are the user's side against base, what they changed there (user's answer)
function countsOf(change: Change): string {
  if (!isConflict(change)) return `+${change.added.length} −${change.removed.length}`;
  const lines = sideAgainstBase(change.base, change.mine ?? []);
  return `+${lines.filter((line) => line.mark === '+').length} −${lines.filter((line) => line.mark === '−').length}`;
}

function statusOf(change: Change, choice?: UpdateChoice): MessageKey {
  if (!isConflict(change)) return 'plugins.update.status.clean';
  return choice === undefined ? 'plugins.update.status.choose' : CHOICE_LABEL[choice];
}

// decision 7: the file only when the item has more than one, since otherwise every row would repeat it
function ChangeRow({ change, choice, hasFiles }: { change: Change; choice?: UpdateChoice; hasFiles: boolean }) {
  const conflict = isConflict(change);
  return (
    <li className={`${COLUMNS} border-b px-3.5 py-2 text-[13px] last:border-b-0`}>
      <span aria-hidden="true" className={conflict ? 'text-destructive' : 'text-working'}>{conflict ? '!' : '✓'}</span>
      <span className="truncate font-mono text-xs">{change.heading}</span>
      <span className="truncate font-mono text-muted-foreground text-xs">{hasFiles ? change.file : ''}</span>
      <span className="font-mono text-muted-foreground text-xs">{countsOf(change)}</span>
      <span className="text-muted-foreground text-xs">{t(statusOf(change, choice))}</span>
    </li>
  );
}

interface BodyProps { item: CatalogueItem; preview: UpdatePreview; choices: Choices; choose(conflictId: string, choice: UpdateChoice): void }

function Body({ item, preview, choices, choose }: BodyProps) {
  const versions = preview.from !== undefined && preview.to !== undefined ? `: ${preview.from} → ${preview.to}` : '';
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-[15px]">{`${t('plugins.update.title', { name: item.name })}${versions}`}</h2>
        <p className="text-muted-foreground text-xs">{`${t('plugins.update.summary')} ${summaryOf(preview.changes)}`.trim()}</p>
      </div>
      <ul aria-label={t('plugins.update.changes')} className="flex flex-col rounded-lg border">
        {preview.changes.map((change, index) => (
          <ChangeRow key={isConflict(change) ? change.id : `${change.file}#clean${index}`} change={change} choice={isConflict(change) ? choices[change.id] : undefined} hasFiles={item.files.length > 1} />
        ))}
      </ul>
      {preview.changes.filter(isConflict).map((conflict) => (
        <ConflictBlock key={conflict.id} conflict={conflict} to={preview.to} choice={choices[conflict.id]} onChoose={(choice) => choose(conflict.id, choice)} />
      ))}
    </>
  );
}

// decision 11: until every conflict has a choice the render keeps the version's current text, and the footer says so in red
function Footer({ left, canApply, onApply, onLater }: { left: number; canApply: boolean; onApply(): void; onLater(): void }) {
  return (
    <footer className="flex items-center gap-3 border-t px-6 py-3">
      {left > 0 && <span className="text-destructive text-xs">{tPlural('plugins.update.left', left, { n: left })}</span>}
      <span aria-hidden="true" className="flex-1" />
      <Button type="button" variant="ghost" size="sm" onClick={onLater}>{t('plugins.update.later')}</Button>
      <Button type="button" size="sm" disabled={!canApply} onClick={onApply}>{t('plugins.update.apply')}</Button>
    </footer>
  );
}

/** Screen 11d (#325): one version's update, read from #324's preview: the title and summary, the changes, each conflict side by side, and the
 * footer. "later" asks nothing and opens the item (decision 16); an apply, and an update gone meanwhile, read the catalogue again first. */
export function UpdateScreen({ plugins, id, version }: { plugins: Plugins; id: string; version: string }) {
  const { reload, open } = plugins;
  const leave = useCallback(async (): Promise<void> => {
    await reload();
    open({ kind: 'item', id });
  }, [reload, open, id]);
  const update = useUpdate(id, version, leave);
  const item = plugins.items?.find((i) => i.id === id);
  if (item === undefined) return null;
  const { preview, notice } = update;
  const left = (preview?.changes.filter(isConflict) ?? []).filter((conflict) => update.choices[conflict.id] === undefined).length;
  return (
    <section aria-label={t('plugins.update.screen')} className="flex min-h-0 flex-1 flex-col">
      <HeaderSlot><UpdateHead item={item} preview={preview} /></HeaderSlot>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        {notice && <p role="alert" className={`text-xs ${notice === 'plugins.update.stale' ? 'text-muted-foreground' : 'text-destructive'}`}>{t(notice)}</p>}
        {preview && <Body item={item} preview={preview} choices={update.choices} choose={update.choose} />}
      </div>
      {preview && <Footer left={left} canApply={left === 0 && !update.isApplying} onApply={() => void update.apply()} onLater={() => open({ kind: 'item', id })} />}
    </section>
  );
}
