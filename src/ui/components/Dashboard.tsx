import type { State } from '../../types';
import { DetailSheet } from '@/components/DetailSheet';
import { Header } from '@/components/Header';
import { HiveBoard } from '@/components/HiveBoard';
import { SlotGrid } from '@/components/SlotGrid';

// tick is not read: its only job is to change every RERENDER_MS so elapsed()/relative readings redraw between events.
export interface DashboardProps { state: State | undefined; selectedSlotId?: string; locale: string; tick: number; onSelect(id?: string): void; onConfigure(): void }

export function Dashboard({ state, selectedSlotId, locale, onSelect, onConfigure }: DashboardProps) {
  if (!state) return null;
  return (
    <>
      <Header state={state} locale={locale} onConfigure={onConfigure} />
      <main className="grid gap-4 p-4">
        <HiveBoard state={state} />
        <SlotGrid state={state} locale={locale} onSelect={onSelect} />
      </main>
      <DetailSheet state={state} slotId={selectedSlotId} locale={locale} onClose={() => onSelect(undefined)} />
    </>
  );
}
