// The state stream's console events (#780): a channel was added or a run's status changed. useHiveState's one EventSource hears them; the
// console's channel list reads GET /console again here, since a formatter or a language server run is no pty the page could watch.
const listeners = new Set<() => void>();

export const onConsoleChange = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const emitConsoleChange = (): void => {
  for (const listener of listeners) listener();
};
