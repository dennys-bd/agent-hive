import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import { distroOf, machineProblems } from '@/lib/machines';
import type { WorkspaceDraft } from '@/lib/settings-form';
import { LOCAL_MACHINE, type MachineStatus } from '../../../types';

interface WorkspaceMachineProps { row: WorkspaceDraft; saved: boolean; machines: readonly MachineStatus[]; onChange(patch: Partial<WorkspaceDraft>): void }

/** Whether a workspace's card shows its machine (#933): when a distro exists, or when the saved machine is gone from the list (it must stay visible, never silently reset). */
export const showsMachine = (machines: readonly MachineStatus[], machine: string): boolean => machines.length > 1 || !machines.some((m) => m.id === machine);

/** The machine a workspace runs on (#933): this computer or a WSL distro, fixed once the workspace is saved; under it, what the chosen distro still lacks. */
export function WorkspaceMachine({ row, saved, machines, onChange }: WorkspaceMachineProps) {
  const id = useId();
  const missing = !machines.some((m) => m.id === row.machine);
  const problems = machineProblems(machines.find((m) => m.id === row.machine));
  return (
    <div className="flex max-w-80 flex-col gap-2">
      <Label htmlFor={id}>{t('settings.workspaces.machine')}</Label>
      <Select value={row.machine} disabled={saved} onValueChange={(machine) => onChange({ machine })}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {machines.map((m) => <SelectItem key={m.id} value={m.id}>{m.id === LOCAL_MACHINE ? t('settings.workspaces.machineLocal') : distroOf(m.id)}</SelectItem>)}
          {/* a saved distro the list no longer holds stays chosen, so saving sends it back unchanged */}
          {missing ? <SelectItem value={row.machine}>{t('settings.workspaces.machineMissing', { distro: distroOf(row.machine) })}</SelectItem> : null}
        </SelectContent>
      </Select>
      {saved ? <span className="text-muted-foreground text-xs">{t('settings.workspaces.machineLocked')}</span> : null}
      {problems.map((p) => <span key={p.key} role="status" className="text-muted-foreground text-xs">{t(p.key, p.vars)}</span>)}
    </div>
  );
}
