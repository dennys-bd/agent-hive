import { Fragment, useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import { getJson } from '@/lib/api';

const ORIGINAL = '__original__'; // Radix Select refuses '' as an item value; an item absent from `items` runs its original
interface PinnedItem { id: string; name: string; kind: string; versions: string[] }
type Pinned = { state: 'loading' } | { state: 'ready'; items: PinnedItem[] } | { state: 'failed' };

// The pin's items (#462): what a run of this experiment can find, never the current store
function usePinnedItems(experimentId: string): Pinned {
  const [pinned, setPinned] = useState<Pinned>({ state: 'loading' });
  useEffect(() => {
    let isLive = true;
    getJson<{ items: PinnedItem[] }>(`/benchmark/experiments/${encodeURIComponent(experimentId)}/items`).then(
      (answer) => { if (isLive) setPinned({ state: 'ready', items: answer.items }); },
      () => { if (isLive) setPinned({ state: 'failed' }); },
    );
    return () => { isLive = false; };
  }, [experimentId]);
  return pinned;
}

interface ItemsFieldProps { experimentId: string; value: Readonly<Record<string, string>>; onChange(items: Record<string, string>): void }

/** Per pinned item, `original` or one of its pinned versions (#471's items, edited here, #462). */
export function ItemsField({ experimentId, value, onChange }: ItemsFieldProps) {
  const pinned = usePinnedItems(experimentId);
  if (pinned.state !== 'ready') return <p className="text-muted-foreground text-xs">{t(pinned.state === 'loading' ? 'benchmark.arms.settings.itemsLoading' : 'benchmark.arms.settings.itemsFailed')}</p>;
  if (pinned.items.length === 0) return <p className="text-muted-foreground text-xs">{t('benchmark.arms.settings.itemsNone')}</p>;
  const pick = (id: string, version: string): void => {
    const { [id]: _previous, ...rest } = value;
    onChange(version === ORIGINAL ? rest : { ...rest, [id]: version });
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_180px] items-center gap-2">
      {pinned.items.map((item) => (
        <Fragment key={item.id}>
          <span className="font-mono text-xs [overflow-wrap:anywhere]">{item.id}</span>
          <Select value={value[item.id] ?? ORIGINAL} onValueChange={(version) => pick(item.id, version)}>
            <SelectTrigger aria-label={t('benchmark.arms.settings.versionOf', { item: item.id })} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ORIGINAL}>{t('benchmark.arms.settings.original')}</SelectItem>
              {item.versions.map((version) => <SelectItem key={version} value={version}>{version}</SelectItem>)}
            </SelectContent>
          </Select>
        </Fragment>
      ))}
    </div>
  );
}
