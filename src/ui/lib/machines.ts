import { useEffect, useState } from 'react';
import type { MessageKey } from '../i18n.js';
import { getJson } from './api.js';
import { LOCAL_MACHINE, type MachineId, type MachineStatus, WSL_MACHINE_PREFIX } from '../../types.js';

const LOCAL_ONLY: readonly MachineStatus[] = [{ id: LOCAL_MACHINE, status: 'ready' }];
const AGENT = 'claude'; // the one agent a workspace's worker needs on a distro

/** A copy line of a distro's problems: its i18n key and params. */
export interface MachineProblem { key: MessageKey; vars: Record<string, string> }

const isList = (answer: unknown): answer is { machines: MachineStatus[] } => typeof answer === 'object' && answer !== null && Array.isArray((answer as { machines?: unknown }).machines);

/** GET /machines, read once per mount (#933): Settings reads it when the workspaces open, never again until they reopen. A failed or malformed
 *  answer is the local machine alone, so the card shows no field. */
export function useMachines(): readonly MachineStatus[] {
  const [machines, setMachines] = useState<readonly MachineStatus[]>(LOCAL_ONLY);
  useEffect(() => {
    let live = true;
    getJson<unknown>('/machines').then((answer) => { if (live && isList(answer)) setMachines(answer.machines); }, () => undefined);
    return () => { live = false; };
  }, []);
  return machines;
}

export const distroOf = (id: MachineId): string => id.slice(WSL_MACHINE_PREFIX.length);

/** What stops a worker on this distro, one line each; none for the local machine, an unlisted one or a ready distro with nothing missing. */
export function machineProblems(machine: MachineStatus | undefined): MachineProblem[] {
  if (machine === undefined || machine.id === LOCAL_MACHINE) return [];
  const distro = distroOf(machine.id);
  if (machine.status === 'stopped' || machine.status === 'node_missing' || machine.status === 'node_old') return [{ key: `machine.status.${machine.status}` as const, vars: { distro } }];
  if (machine.status !== 'ready') return [{ key: 'machine.status.unreachable' as const, vars: { distro, reason: machine.status } }];
  const claude = machine.agents?.find((a) => a.agent === AGENT);
  return [
    ...(claude?.available === false ? [{ key: 'machine.status.noAgent' as const, vars: { distro, agent: AGENT } }] : []),
    ...(claude?.available !== false && claude?.loggedIn === false ? [{ key: 'machine.agentLoggedOut' as const, vars: { agent: AGENT, machine: distro } }] : []),
    ...(machine.gh === false ? [{ key: 'machine.status.noGh' as const, vars: { distro } }] : []),
  ];
}
