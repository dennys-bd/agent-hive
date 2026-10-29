import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BenchFlow } from '../../../../types';
import { ArmFlowChart } from '@/components/benchmark/arms/ArmFlowChart';
import { GroupHeading, ROW_GRID } from '@/components/benchmark/arms/RowGroup';
import { dayMonth } from '@/components/benchmark/sidebar-groups';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { clockOf } from '@/lib/design-comments';
import { listOf } from '@/lib/settings-languages';

interface FlowGroupProps {
  workspace: string; flow: BenchFlow; // the shown setup's
  picked: string; onPick(name: string): void;
  marked: ReadonlySet<string>; isArm: boolean;
  editor: ReactNode; // the picked stage's RowGroup with its StageEditor: ArmSettings builds it, so the draft never reaches this file
  onOpenSettings?(): void; // the base's link to Settings > flow; absent, no link
}

/** The flow group of the settings (#536): the flow's select (one flow per Hive until #485, so it only names the experiment's own copy), the
 * copy note, the chart, and the picked stage's editor. */
export function FlowGroup({ workspace, flow, picked, onPick, marked, isArm, editor, onOpenSettings }: FlowGroupProps) {
  const when = `${dayMonth(flow.copiedAt)} ${clockOf(new Date(flow.copiedAt))}`;
  return (
    <>
      <GroupHeading title={t('benchmark.arms.settings.group.flow')} hint={t('benchmark.arms.settings.group.flowHint')} />
      <div className={ROW_GRID}>
        <span className="pt-1">{t('benchmark.arms.settings.flowSelect')}</span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" variant="outline" disabled aria-label={t('benchmark.arms.settings.flowSelect')} className="justify-between gap-2 font-normal">
              {workspace}<ChevronDownIcon aria-hidden="true" />
            </Button>
            <span className="text-muted-foreground text-xs">{t('benchmark.arms.settings.copyNote', { when })}</span>
          </span>
          {flow.dropped.length > 0 && <span className="text-muted-foreground text-xs">{t('benchmark.arms.settings.dropped', { list: listOf(flow.dropped, t('settings.formatters.and')) })}</span>}
        </div>
        <div className="pt-1 text-xs">
          {isArm
            ? <span className="text-muted-foreground">{t('benchmark.arms.settings.same')}</span>
            : onOpenSettings && <Button type="button" size="sm" variant="link" className="h-auto p-0 text-[13px]" onClick={onOpenSettings}>{t('benchmark.arms.settings.openInSettings')}</Button>}
        </div>
      </div>
      <ArmFlowChart stages={flow.stages} transitions={flow.transitions} picked={picked} marked={marked} isArm={isArm} onPick={onPick} />
      {editor}
    </>
  );
}
