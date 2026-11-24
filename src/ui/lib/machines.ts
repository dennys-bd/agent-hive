import { useEffect, useState } from 'react';
import type { MessageKey } from '../i18n.js';
import { getJson } from './api.js';
import { LOCAL_MACHINE, type MachineId, type MachineStatus, WSL_MACHINE_PREFIX } from '../../types.js';

const LOCAL_ONLY: readonly MachineStatus[] = [{ id: LOCAL_MACHINE, status: 'ready' }];
const AGENT = 'claude'; // the one agent a workspace's worker needs on a distro

/** A copy line of a distro's problems: its i18n key and params. */
export interface MachineProblem { key: MessageKey; vars: Record<string, string> }

const isStatus = (m: unknown): m is MachineStatus => typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string' && typeof (m as { status?: unknown }).status === 'string';
// a row without a string id or status would throw in render, so any such row makes the whole answer malformed
const isList = (answer: unknown): answer is { machines: MachineStatus[] } => {
  const machines = typeof answer === 'object' && answer !== null ? (answer as { machines?: unknown }).machines : undefined;
  return Array.isArray(machines) && machines.every(isStatus);
};

/** GET /machines, read once per mount (#933): Settings reads it when the workspaces open, never again until they reopen. A failed or malformed
 *  answer is the local machine alone, so the card shows no field. Undefined until it answers: a saved distro would otherwise flash as not found. */
export function useMachines(): readonly MachineStatus[] | undefined {
  const [machines, setMachines] = useState<readonly MachineStatus[]>();
  useEffect(() => {
    let live = true;
    const settle = (list: readonly MachineStatus[]): void => { if (live) setMachines(list); };
    getJson<unknown>('/machines').then((answer) => settle(isList(answer) ? answer.machines : LOCAL_ONLY), () => settle(LOCAL_ONLY));
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
