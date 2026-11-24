// GET /machines (#946, node 5.4 of #942): the machines a workspace can be on and what each can run: local first, then every WSL distro in
// wsl.exe -l -q order. Listing never wakes a stopped distro (decision 1); each running one is asked in parallel (decision 11).
import type { Express, Request, Response } from 'express';
import type { Machines } from './machine.js';
import { type AccountsConfig, type MachineStatus, WSL_MACHINE_PREFIX } from './types.js';
import { distroStatus, localStatus, STOPPED, type VersionedMachine } from './wsl/distro-status.js';
import { HELPER_FAILED } from './wsl/helper-install.js';
import { listDistros, type WslDeps } from './wsl/wsl-exe.js';

export interface MachineRouteDeps {
  machines: Machines;
  platform: NodeJS.Platform;
  wsl: WslDeps; // the server's wsl.exe and runner, the ones the distros' machines use
  accounts(): AccountsConfig | undefined; // the saved selection; undefined in setup mode
}

/** Every machine's status: local alone off win32, or when wsl.exe is missing or fails (listDistros answers []). */
export async function machineStatuses(deps: MachineRouteDeps): Promise<MachineStatus[]> {
  const local = localStatus(deps.machines.local);
  if (deps.platform !== 'win32') return [local];
  const [distros, running] = await Promise.all([listDistros(deps.wsl), listDistros(deps.wsl, { running: true })]);
  const skipLogin = deps.accounts()?.claude !== undefined; // decision 2
  const statusOf = async (distro: string): Promise<MachineStatus> => {
    const id = `${WSL_MACHINE_PREFIX}${distro}`;
    if (!running.includes(distro)) return { id, status: STOPPED }; // its machine is never built, so nothing can wake it
    const machine: VersionedMachine = deps.machines.for({ machine: id });
    // one distro's failure is its own row, never the whole answer's
    return distroStatus(machine, { skipLogin }).catch(() => ({ id, status: HELPER_FAILED }));
  };
  return [local, ...(await Promise.all(distros.map(statusOf)))];
}

export function registerMachineRoutes(app: Express, deps: MachineRouteDeps): void {
  app.get('/machines', async (_req: Request, res: Response) => {
    res.json({ machines: await machineStatuses(deps) });
  });
}
