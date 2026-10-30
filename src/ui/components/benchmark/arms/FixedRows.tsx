import { LockIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Experiment } from '../../../../types';
import { GroupHeading, ROW_GRID } from '@/components/benchmark/arms/RowGroup';
import { dayMonth } from '@/components/benchmark/sidebar-groups';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { clockOf } from '@/lib/design-comments';

const PIN_HASH_CHARS = 6;
const COMMIT_CHARS = 7;

export const pluginText = (e: Experiment): string => `hive ${e.plugin.version} · ${e.plugin.hash.slice(0, PIN_HASH_CHARS)}`;
export const seedText = (e: Experiment): string => `${e.seed.workspace} @ ${e.seed.commit.slice(0, COMMIT_CHARS)} · ${e.seedHash.slice(0, PIN_HASH_CHARS)}`;

function Pinned({ label, value, state }: { label: string; value: string; state: ReactNode }) {
  return (
    <div className={ROW_GRID}>
      <span className="pt-1">{label}</span>
      <span className="flex items-center gap-2 pt-1">
        <span className="font-mono">{value}</span>
        <LockIcon role="img" aria-label={t('benchmark.arms.settings.pinnedMark')} className="size-3 text-muted-foreground" />
      </span>
      <span className="pt-1 text-muted-foreground text-xs">{state}</span>
    </div>
  );
}

/** The base's pinned rows (#536): the plugin and the seed, with their hash. Not editable: changing one makes another benchmark, which Config does. */
export function FixedRows({ experiment, onShowConfig }: { experiment: Experiment; onShowConfig(): void }) {
  const when = `${dayMonth(experiment.createdAt)} ${clockOf(new Date(experiment.createdAt))}`;
  return (
    <>
      <GroupHeading title={t('benchmark.arms.settings.fixed')} hint={t('benchmark.arms.settings.fixedHint')} />
      <Pinned label={t('benchmark.arms.base.plugin')} value={pluginText(experiment)} state={when} />
      <Pinned
        label={t('benchmark.arms.base.seed')} value={seedText(experiment)}
        state={<Button type="button" size="sm" variant="link" className="h-auto p-0 text-[13px]" onClick={onShowConfig}>{t('benchmark.arms.settings.seeInConfig')}</Button>}
      />
    </>
  );
}
