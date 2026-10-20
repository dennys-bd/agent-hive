import { useEffect, useEffectEvent } from 'react';
import { onShortcutKey } from '@/lib/dock-layout';
import { isTextField } from '@/lib/shortcut-bindings';

const MOUSE_BACK = 3; // the mouse's back side button: Electron on macOS reports it as button 3

/** ⌘[ (goBack, #585) and the mouse's back button call `onBack` while it is given: while the back button shows (#911). Both on window, as every
 * shortcut is; the mouse's default is prevented. The listeners read the latest render's onBack. */
export function useBackKeys(onBack: (() => void) | undefined): void {
  const isOn = onBack !== undefined;
  const act = useEffectEvent((): void => onBack?.());
  useEffect(() => {
    if (!isOn) return undefined;
    // Not in a text field: Alt+Left, its default off macOS, moves by word there, and a back would drop a draft
    const offKey = onShortcutKey([[true, 'goBack']], () => act(), (event) => !isTextField(event.target));
    const onMouse = (event: MouseEvent): void => {
      if (event.button !== MOUSE_BACK) return;
      event.preventDefault();
      act();
    };
    window.addEventListener('mouseup', onMouse);
    return () => {
      offKey();
      window.removeEventListener('mouseup', onMouse);
    };
  }, [isOn]);
}
