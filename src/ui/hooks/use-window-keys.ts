// The window's own global keys that no panel owns (#585): close window through the page's IPC, as the menu does, and the signal range. The
// same capture-phase listeners as every shortcut, so they work with the focus in a terminal; bound only while the window's keys are (off in
// the terminal's harness).
import { useEffect, useRef } from 'react';
import type { EffectiveLimits } from '../../types';
import { act } from '@/components/actions';
import { SIGNALS } from '@/components/SignalToggle';
import { onFixedKey, onShortcutKey } from '@/lib/dock-layout';

export function useWindowKeys(isOn: boolean, effective?: EffectiveLimits): void {
  // The key does what the flow sidebar's toggle does: a signal looser than a fired rule's floor is disabled there, so it is not set here
  const floor = useRef(0);
  useEffect(() => {
    floor.current = SIGNALS.indexOf(effective?.floor.signal ?? 'green');
  });
  // The menu item carries the same accelerator, but this capture-phase listener prevents the key first, so the window closes once
  useEffect(() => (isOn ? onShortcutKey([[true, 'closeWindow']], () => void window.hive?.closeWindow()) : undefined), [isOn]);
  useEffect(() => (isOn ? onFixedKey('signal', (rank) => {
    if (rank >= floor.current) void act('/signal', { signal: SIGNALS[rank] });
  }) : undefined), [isOn]);
}
