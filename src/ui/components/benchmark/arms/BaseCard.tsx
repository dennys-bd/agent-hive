import { LockIcon } from 'lucide-react';
import type { Experiment } from '../../../../types';
import { CardFooter, TASKS_HASH_CHARS } from '@/components/benchmark/arms/ArmCard';
import { pluginText, seedText } from '@/components/benchmark/arms/FixedRows';
import { stageCall } from '../../../../benchmark/arms.js';
import { runsAgent } from '../../../../stage-agent.js';
import { pickText, plural, rowLabel, rowText } from '@/components/benchmark/arms/arm-rows';
import { dayMonth } from '@/components/benchmark/sidebar-groups';
import { t } from '@/i18n';
import { clockOf } from '@/lib/design-comments';

interface BaseRow { label: string; value: string; isPinned?: boolean }

// The flow by its workspace and size, then each stage that runs an agent, as the screen's base card
function baseRows(e: Experiment): BaseRow[] {
  const { stages } = e.base.flow;
  const agentStages = stages.filter(runsAgent);
  const { allow, deny } = e.base.rules;
  return [
    { label: rowLabel('flow'), value: `${e.workspace} · ${plural(stages.length, 'benchmark.arms.value.stages.one', 'benchmark.arms.value.stages.other')}` },
    ...agentStages.map((s) => ({ label: s.name, value: pickText(s.agent, s.model) })),
    { label: t('benchmark.arms.row.skills'), value: agentStages.flatMap((s) => stageCall(s) ?? []).join(' ') },
    { label: t('benchmark.arms.base.plugin'), value: pluginText(e), isPinned: true },
    { label: t('benchmark.arms.base.seed'), value: seedText(e), isPinned: true },
    { label: rowLabel('tasks'), value: `${rowText(e.base, 'tasks')} · t·${e.tasksHash.slice(0, TASKS_HASH_CHARS)}` },
    { label: t('benchmark.arms.row.rules'), value: t('benchmark.arms.value.rules', { allowed: allow.length, denied: deny.join(', ') || '0' }) },
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
