import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Machine, MachineChild } from '../../src/machine.js';
import { fakeMachine } from '../fake-machine.js';

// A machine whose git grep is scripted per working folder (#868): what it prints, its stderr and exit code; or held open until it is killed
export interface Script { out?: Buffer[]; err?: string; code?: number; isHeld?: boolean } // isHeld: never closes until killed
export function grepMachine(byCwd: Record<string, Script>, base: Machine = fakeMachine()): { machine: Machine; killed: string[]; ran: string[] } {
  const killed: string[] = [];
  const ran: string[] = [];
  const process: Machine['process'] = (_command, _args, { cwd }) => {
    ran.push(cwd);
    const { out = [], err = '', code = 0, isHeld = false } = byCwd[cwd] ?? { code: 1 };
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1,
      kill: () => { killed.push(cwd); setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; } });
    setImmediate(() => {
      for (const chunk of out) child.stdout.write(chunk);
      child.stderr.write(err);
      if (!isHeld) setImmediate(() => child.emit('close', code, null));
    });
    return child as unknown as MachineChild;
  };
  return { machine: { ...base, process }, killed, ran };
}

