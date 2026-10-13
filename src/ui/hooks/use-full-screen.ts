import { createContext, useContext, useEffect, useState } from 'react';
import { isMac } from '@/lib/shortcut-bindings';

/** Whether the window is in full screen (#295), as App's useFullScreen reads it; false outside App (a header rendered alone). */
export const FullScreenContext = createContext(false);

/** What the header lays its left column out by (#295). */
export const useIsFullScreen = (): boolean => useContext(FullScreenContext);

// The bridge's state at load, then its events. The preload holds one listener, as onCloseKey does: App alone subscribes, through useFullScreen
function useWindowFullScreen(isOn: boolean): boolean {
  const [isFullScreen, setIsFullScreen] = useState(false);
  useEffect(() => {
    const bridge = window.hive;
    if (!isOn || bridge === undefined) return undefined;
    let hasEvent = false; // an enter or leave after the question and before its answer is the newer state
    const off = bridge.onFullScreen((on) => {
      hasEvent = true;
      setIsFullScreen(on);
    });
    // A refused read (the page outlived its window) leaves the window's inset: the next enter event corrects it
    bridge.isFullScreen().then((on) => { if (!hasEvent) setIsFullScreen(on); }, () => undefined);
    return off;
  }, [isOn]);
  return isFullScreen;
}

/** The window's full screen (#295, header-estados.md): macOS hides the window buttons there. Off macOS the window has none at the header's
 * left, so it always reads as full screen; on macOS without a bridge (a plain browser) as a window. Mirrored on the root as data-fullscreen,
 * which index.css turns into the header's and Settings' insets. App calls it once and hands the value on through FullScreenContext. */
export function useFullScreen(): boolean {
  const isOffMac = !isMac();
  const isFullScreen = useWindowFullScreen(!isOffMac) || isOffMac;
  useEffect(() => {
    document.documentElement.toggleAttribute('data-fullscreen', isFullScreen);
  }, [isFullScreen]);
  return isFullScreen;
}
