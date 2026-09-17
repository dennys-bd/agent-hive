import type { State } from '../../types';

export interface DashboardProps { state: State | undefined; selectedSlotId?: string; onSelect(id?: string): void; onConfigure(): void }

export function Dashboard({ state }: DashboardProps) {
  return <pre className="p-4 text-muted-foreground">{state?.lastPolledAt ?? '…'}</pre>; // Task 4 fills this in
}
