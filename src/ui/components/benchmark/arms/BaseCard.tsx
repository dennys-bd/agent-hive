import { LockIcon } from 'lucide-react';
import type { Experiment } from '../../../../types';
import { CardFooter, TASKS_HASH_CHARS } from '@/components/benchmark/arms/ArmCard';
import { ROLES, rowLabel, rowText } from '@/components/benchmark/arms/arm-rows';
import { dayMonth } from '@/components/benchmark/sidebar-groups';
import { t } from '@/i18n';
import { clockOf } from '@/lib/design-comments';

const PIN_HASH_CHARS = 6;
const COMMIT_CHARS = 7;
interface BaseRow { label: string; value: string; isPinned?: boolean }

function baseRows(e: Experiment): BaseRow[] {
  return [
    ...ROLES.map((role) => ({ label: t(rowLabel(role)), value: rowText(e.base, role) })),
    { label: t(rowLabel('skills')), value: rowText(e.base, 'skills') },
    { label: t('benchmark.arms.base.plugin'), value: `hive ${e.plugin.version} · ${e.plugin.hash.slice(0, PIN_HASH_CHARS)}`, isPinned: true },
    { label: t('benchmark.arms.base.seed'), value: `${e.seed.workspace} @ ${e.seed.commit.slice(0, COMMIT_CHARS)} · ${e.seedHash.slice(0, PIN_HASH_CHARS)}`, isPinned: true },
    { label: t(rowLabel('tasks')), value: `${rowText(e.base, 'tasks')} · t·${e.tasksHash.slice(0, TASKS_HASH_CHARS)}` },
    { label: t(rowLabel('rules')), value: rowText(e.base, 'rules') },
  ];
}

/** The base (#462, the screen's base card): what every arm starts from, the plugin and seed pinned with their hash at creation. */
export function BaseCard({ experiment, onOpen }: { experiment: Experiment; onOpen(): void }) {
  const pinned = t('benchmark.arms.base.pinned', { when: `${dayMonth(experiment.createdAt)} ${clockOf(new Date(experiment.createdAt))}` });
  return (
    <section aria-label={t('benchmark.arms.base.title')} className="flex min-w-0 flex-col rounded-xl border bg-muted/50 shadow-sm">
      <header className="flex items-baseline gap-2.5 px-3.5 py-2.5">
        <b className="font-semibold text-sm">{t('benchmark.arms.base.title')}</b>
        <span className="text-muted-foreground text-xs">{t('benchmark.arms.base.hint')}</span>
      </header>
      <dl className="m-0 flex flex-col gap-2 px-3.5 py-3 text-[13px]">
        {baseRows(experiment).map((row) => (
          <div key={row.label} className="grid grid-cols-[64px_minmax(0,1fr)] items-baseline gap-2">
            <dt className="text-muted-foreground text-xs">{row.label}</dt>
            <dd className="m-0 flex min-w-0 items-baseline gap-1.5 [overflow-wrap:anywhere]">
              <span>{row.value}</span>
              {row.isPinned && <span title={pinned} className="flex text-muted-foreground"><LockIcon aria-hidden="true" className="size-3" /></span>}
            </dd>
          </div>
        ))}
      </dl>
      <CardFooter text={t('benchmark.arms.base.note')} onOpen={onOpen} />
    </section>
  );
}
