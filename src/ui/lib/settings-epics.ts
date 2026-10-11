import { SWITCH_AT_DEFAULT } from '../../types.js';
import type { StageDraft } from './settings-stages.js';

// A source's switchAt in the settings form (#30): a stage draft's id, as transitions and createIn are kept, so a stage renamed while it is
// edited carries it. '' is a new row's: the default.

/** The stage switchAt resolves to: the id's stage while it exists, else the one named Build, else the flow's first; undefined with no stage. */
export function switchAtStage(id: string, stages: readonly StageDraft[]): StageDraft | undefined {
  return stages.find((s) => s.id === id) ?? stages.find((s) => s.name.trim() === SWITCH_AT_DEFAULT) ?? stages[0];
}

/** The name toSettingsBody sends: the resolved stage's; '' only with no stage, which validateSettings refuses before a save. */
export const switchAtName = (id: string, stages: readonly StageDraft[]): string => switchAtStage(id, stages)?.name.trim() ?? '';

/** A saved switchAt as its stage draft's id; '' (the default) when no stage has the name, which the parser never lets through. */
export const switchAtId = (name: string, stages: readonly StageDraft[]): string => stages.find((s) => s.name.trim() === name)?.id ?? '';
