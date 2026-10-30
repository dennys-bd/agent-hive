import { useState } from 'react';
import { isLocked as isLockedExperiment, nextLetter } from '../../../../benchmark/arms.js';
import type { Arm, Experiment } from '../../../../types';
import { addArm, removeArm } from '@/components/benchmark/arms/arm-api';
import { ArmCard, ArmName } from '@/components/benchmark/arms/ArmCard';
import { ArmMenu } from '@/components/benchmark/arms/ArmMenu';
import { armRows } from '@/components/benchmark/arms/arm-rows';
import { ArmSettings } from '@/components/benchmark/arms/ArmSettings';
import { BaseCard } from '@/components/benchmark/arms/BaseCard';
import type { Benchmark } from '@/components/benchmark/benchmark-dock';
import { Confirm } from '@/components/Confirm';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';

// + braço: from the base, or a copy of another arm's overrides, tasks included (#459). Disabled at 26 arms or while locked
function AddArm({ experiment }: { experiment: Experiment }) {
  const isDisabled = isLockedExperiment(experiment) || nextLetter(experiment.arms) === undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={isDisabled}>
        <button type="button" disabled={isDisabled} className="flex items-center gap-2 rounded-lg border border-dashed px-3.5 py-2.5 text-left text-[13px] text-muted-foreground hover:bg-accent/50 disabled:opacity-35">
          <b className="font-normal text-foreground">{t('benchmark.arms.add')}</b><span>{t('benchmark.arms.addHint')}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => void addArm(experiment.id, 'base')}>{t('benchmark.arms.addFromBase')}</DropdownMenuItem>
        {experiment.arms.map((a) => <DropdownMenuItem key={a.id} onSelect={() => void addArm(experiment.id, a.id)}>{`${a.letter} · ${a.name}`}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ArmSlotProps { experiment: Experiment; arm: Arm; benchmark: Benchmark; onOpen(): void; onRemove(): void }

function ArmSlot({ experiment, arm, benchmark, onOpen, onRemove }: ArmSlotProps) {
  const [isRenaming, setRenaming] = useState(false);
  const count = armRows(experiment.base, arm.overrides).filter((r) => r.overridden).length;
  return (
    <ArmCard
      experiment={experiment} arm={arm} onOpen={onOpen}
      name={isRenaming ? <ArmName experimentId={experiment.id} arm={arm} onDone={() => setRenaming(false)} /> : undefined}
      menu={<ArmMenu experiment={experiment} arm={arm} overrideCount={count} onRename={() => setRenaming(true)} onRemove={onRemove} onCompare={() => benchmark.showInCompare(arm.id)} />}
    />
  );
}

export interface ArmsTabProps { experiment: Experiment; benchmark: Benchmark }

/** The braços tab (#462, benchmark.hv.html #s-visao): the base card beside the arm cards, + braço, the remove confirmation and the open settings. */
export function ArmsTab({ experiment, benchmark }: ArmsTabProps) {
  const [settingsOf, setSettingsOf] = useState<{ armId?: string }>(); // {} is the base
  const [removing, setRemoving] = useState<Arm>();
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-3">
        <BaseCard experiment={experiment} onOpen={() => setSettingsOf({})} />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-stretch gap-3">
          {experiment.arms.map((arm) => <ArmSlot key={arm.id} experiment={experiment} arm={arm} benchmark={benchmark} onOpen={() => setSettingsOf({ armId: arm.id })} onRemove={() => setRemoving(arm)} />)}
        </div>
      </div>
      <AddArm experiment={experiment} />
      {settingsOf !== undefined && <ArmSettings key={settingsOf.armId ?? 'base'} experiment={experiment} armId={settingsOf.armId} onClose={() => setSettingsOf(undefined)} onShowConfig={() => { benchmark.setTab('config'); setSettingsOf(undefined); }} onOpenFlowSettings={benchmark.slots.openFlowSettings} />}
      {removing !== undefined && (
        <Confirm
          danger open title={t('benchmark.arms.remove.title')} context={<span className="font-mono">{`${removing.letter} · ${removing.name}`}</span>}
          message={t('benchmark.arms.remove.text')} confirmLabel={t('benchmark.arms.remove.confirm')}
          onConfirm={async () => { await removeArm(experiment.id, removing.id); }} onOpenChange={(isOpen) => { if (!isOpen) setRemoving(undefined); }}
        />
      )}
    </div>
  );
}
