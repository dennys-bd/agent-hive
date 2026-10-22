// The arm routes as the arms tab posts them (#459, #462). Each answers whether the route took it; a refusal has already toasted through send.
import type { ArmOverrides, ArmSetup } from '../../../../types';
import { send } from '@/components/benchmark/send';

const E = '/benchmark/experiments';
const experimentPath = (id: string): string => `${E}/${encodeURIComponent(id)}`;
const armPath = (id: string, armId: string): string => `${experimentPath(id)}/arms/${encodeURIComponent(armId)}`;
const isTaken = async (answer: Promise<unknown>): Promise<boolean> => (await answer) !== undefined;

export const editArm = (id: string, armId: string, patch: { name?: string; overrides?: ArmOverrides }): Promise<boolean> => isTaken(send('PATCH', armPath(id, armId), patch));
export const patchBase = (id: string, base: ArmSetup): Promise<boolean> => isTaken(send('PATCH', experimentPath(id), { base }));
