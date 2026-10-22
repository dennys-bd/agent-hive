import { useState } from 'react';
import type { Experiment } from '../../../../types';
import { ArmCard } from '@/components/benchmark/arms/ArmCard';
import { ArmSettings } from '@/components/benchmark/arms/ArmSettings';
import { BaseCard } from '@/components/benchmark/arms/BaseCard';
import type { Benchmark } from '@/components/benchmark/benchmark-dock';

export interface ArmsTabProps { experiment: Experiment; benchmark: Benchmark }

/** The braços tab (#462, benchmark.hv.html #s-visao): the base card beside the arm cards, and the settings of whichever one is open. */
export function ArmsTab({ experiment }: ArmsTabProps) {
  const [settingsOf, setSettingsOf] = useState<{ armId?: string }>(); // {} is the base
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-3">
        <BaseCard experiment={experiment} onOpen={() => setSettingsOf({})} />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-stretch gap-3">
          {experiment.arms.map((arm) => <ArmCard key={arm.id} experiment={experiment} arm={arm} onOpen={() => setSettingsOf({ armId: arm.id })} />)}
        </div>
      </div>
      {settingsOf !== undefined && (
        <ArmSettings key={settingsOf.armId ?? 'base'} experiment={experiment} armId={settingsOf.armId} onClose={() => setSettingsOf(undefined)} />
      )}
    </div>
  );
}
