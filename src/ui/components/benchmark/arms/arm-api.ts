// The arm routes as the arms tab posts them (#459, #462). Each answers whether the route took it; a refusal has already toasted through send.
import type { ArmOverrides, ArmSetup } from '../../../../types';
import { send } from '@/components/benchmark/send';

const E = '/benchmark/experiments';
const experimentPath = (id: string): string => `${E}/${encodeURIComponent(id)}`;
const armPath = (id: string, armId: string): string => `${experimentPath(id)}/arms/${encodeURIComponent(armId)}`;
const isTaken = async (answer: Promise<unknown>): Promise<boolean> => (await answer) !== undefined;

export const editArm = (id: string, armId: string, patch: { name?: string; overrides?: ArmOverrides }): Promise<boolean> => isTaken(send('PATCH', armPath(id, armId), patch));
export const patchBase = (id: string, base: ArmSetup): Promise<boolean> => isTaken(send('PATCH', experimentPath(id), { base }));
export const addArm = (id: string, from: string): Promise<boolean> => isTaken(send('POST', `${experimentPath(id)}/arms`, { from }));
export const removeArm = (id: string, armId: string): Promise<boolean> => isTaken(send('DELETE', armPath(id, armId)));
// One post for every target: one post per pick would race the reducer (spec)
export const copyArm = (id: string, armId: string, what: 'overrides' | 'tasks', to: string[]): Promise<boolean> => isTaken(send('POST', `${armPath(id, armId)}/copy`, { what, to }));
