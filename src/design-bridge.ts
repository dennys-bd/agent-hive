// The design frame's bridge (#108): the one script the Hive puts into a design. It runs inside the sandboxed frame, whose origin is
// opaque, so it talks to the design pane by postMessage alone. The comment mode (3.2) extends this same function.

/** Runs inside the frame. bridgeScript serializes it, so it stays self-contained: no import and no name from this module, only what a
 *  browser has. */
export function designBridge(): void {
  const parent = window.parent;
  const root = document.documentElement;
  // '*': the frame cannot know which allowed host the parent was opened on, and ready and size carry nothing worth hiding
  const post = (message: { type: string; height?: number }): void => parent.postMessage({ hive: 'design', ...message }, '*');
  let height = -1;
  const postSize = (): void => {
    if (root.scrollHeight === height) return;
    height = root.scrollHeight;
    post({ type: 'size', height });
  };
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (event.source !== parent || typeof data !== 'object' || data === null) return; // the design itself may post too
    const { hive, type, theme } = data as Record<string, unknown>;
    if (hive !== 'design' || type !== 'theme' || (theme !== 'dark' && theme !== 'light')) return;
    root.style.colorScheme = theme;
    root.dataset.theme = theme;
  });
  // ready on every load: the parent reloads the frame on a version change and marks it reloaded at the ready that follows
  window.addEventListener('load', () => {
    post({ type: 'ready' });
    postSize();
  });
  const observer = new ResizeObserver(postSize);
  observer.observe(root);
}

/** The bridge as the inline script the design frame route puts into every HTML page it serves (#108): inline, so it needs no route. */
export const bridgeScript = (): string => `<script>(${designBridge.toString()})()</script>`;
