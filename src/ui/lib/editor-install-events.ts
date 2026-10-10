// The state stream's editorInstall events (#780): useHiveState's one EventSource hears them; Settings and the LSP sessions listen here.
import type { EditorInstallEvent } from '../../types';

const listeners = new Set<(event: EditorInstallEvent) => void>();

export const onEditorInstall = (listener: (event: EditorInstallEvent) => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const emitEditorInstall = (event: EditorInstallEvent): void => {
  for (const listener of listeners) listener(event);
};
