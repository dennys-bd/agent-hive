// What a signal holds back (#727), from its row of the table: the footer beside the effective signal, the flow sidebar under the toggle.
import { type MessageKey, t } from '../i18n.js';
import { behaviourOf, effectOf, type SignalEffect } from '../../signals.js';
import type { Signal, SignalSettings } from '../../types.js';

const KEY: Record<SignalEffect, MessageKey> = {
  noNewTasks: 'signal.effect.noNewTasks', newTasksFromTree: 'signal.effect.newTasksFromTree', noResume: 'signal.effect.noResume',
  noMoveOn: 'signal.effect.noMoveOn', noWorkerless: 'signal.effect.noWorkerless',
};

/** The effect text: undefined under a green that holds nothing back; "like green" for yellow or red holding nothing back either. Green
 * names its effects once its newTasks is not always (#32). */
export function signalEffect(signal: Signal, signals: Pick<SignalSettings, 'green' | 'yellow' | 'red'>): string | undefined {
  const parts = effectOf(behaviourOf(signal, signals));
  if (parts.length === 0) return signal === 'green' ? undefined : t('signal.effect.likeGreen');
  return parts.map((part) => t(KEY[part])).join(' · ');
}
