// What a signal holds back (#727), from its row of the table: the footer beside the effective signal, the flow sidebar under the toggle.
import { type MessageKey, t } from '../i18n.js';
import { behaviourOf, effectOf, type SignalEffect } from '../../signals.js';
import type { Signal, SignalSettings } from '../../types.js';

const KEY: Record<SignalEffect, MessageKey> = {
  noNewTasks: 'signal.effect.noNewTasks', noResume: 'signal.effect.noResume', noMoveOn: 'signal.effect.noMoveOn', noWorkerless: 'signal.effect.noWorkerless',
};

/** The effect text: undefined under green, which holds nothing back; "like green" for a row that holds nothing back either. */
export function signalEffect(signal: Signal, signals: Pick<SignalSettings, 'yellow' | 'red'>): string | undefined {
  if (signal === 'green') return undefined;
  const parts = effectOf(behaviourOf(signal, signals));
  return parts.length === 0 ? t('signal.effect.likeGreen') : parts.map((part) => t(KEY[part])).join(' · ');
}
