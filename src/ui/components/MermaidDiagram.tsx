import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

type Mermaid = typeof import('mermaid').default;
type Drawn = { status: 'loading' } | { status: 'ready'; svg: string } | { status: 'error'; message: string };

let mermaidLoad: Promise<Mermaid> | undefined;
// Imported the first time a preview holds a diagram (#697), once per page, as Monaco is: the library weighs a few MB
const loadMermaid = (): Promise<Mermaid> => (mermaidLoad ??= import('mermaid').then((module) => module.default));

// The page's resolved theme (#296): lib/theme.ts sets data-theme on <html>, as monaco-themes.ts reads it; next-themes is not its source here
function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
const themeNow = (): 'neutral' | 'dark' => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral');

// One drawing: strict mode sanitizes labels and blocks click callbacks; suppressErrorRendering keeps mermaid's own error diagram out of the page
async function draw(id: string, code: string, theme: 'neutral' | 'dark'): Promise<string> {
  const mermaid = await loadMermaid();
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, suppressErrorRendering: true });
  return (await mermaid.render(id, code)).svg;
}

// Drawings by theme and code (#906): a diagram mounted again with the same text shows its drawing at once instead of its code
const CACHE_LIMIT = 50;
const drawings = new Map<string, string>();
function remember(key: string, svg: string): void {
  drawings.delete(key);
  drawings.set(key, svg);
  const oldest = drawings.keys().next();
  if (drawings.size > CACHE_LIMIT && oldest.done !== true) drawings.delete(oldest.value);
}
const cachedDrawing = (key: string): Drawn => {
  const svg = drawings.get(key);
  return svg === undefined ? { status: 'loading' } : { status: 'ready', svg };
};

/** A ```mermaid block as its diagram (#697), drawn again when its code or the app's theme changes, the previous drawing kept meanwhile
 * (#906). Before its first drawing, the code block; on a parse error, the code block and the message. */
export function MermaidDiagram({ code }: { code: string }) {
  const id = `mermaid-${useId().replace(/[^\w-]/g, '')}`; // mermaid takes it as a CSS id: useId's colons and guillemets go
  const theme = useSyncExternalStore(subscribeTheme, themeNow);
  const host = useRef<HTMLDivElement>(null);
  const key = `${theme}\n${code}`;
  const [drawn, setDrawn] = useState<Drawn>(() => cachedDrawing(key));
  // A layout effect, so a cached drawing replaces the previous one before the browser paints it
  useLayoutEffect(() => {
    const cached = drawings.get(key);
    if (cached !== undefined) {
      setDrawn((now) => (now.status === 'ready' && now.svg === cached ? now : { status: 'ready', svg: cached }));
      return;
    }
    // The previous drawing stays while this one draws; a previous error does not, it belonged to the old code
    setDrawn((now) => (now.status === 'error' ? { status: 'loading' } : now));
    let live = true;
    draw(id, code, theme).then(
      // Cached even when the effect is gone: the entry is keyed by its own code and theme, so a late drawing is still right
      (svg) => { remember(key, svg); if (live) setDrawn({ status: 'ready', svg }); },
      (err: unknown) => { if (live) setDrawn({ status: 'error', message: err instanceof Error ? err.message : String(err) }); },
    );
    return () => { live = false; };
  }, [id, key, code, theme]);
  // mermaid's own strict-mode SVG, never the document's text, set on its container (no dangerouslySetInnerHTML: Biome refuses it)
  useLayoutEffect(() => {
    if (drawn.status === 'ready' && host.current !== null) host.current.innerHTML = drawn.svg;
  }, [drawn]);
  if (drawn.status === 'ready') return <div ref={host} data-mermaid="" className="flex justify-center overflow-auto py-2" />;
  return (
    <div className="flex flex-col gap-1">
      <pre><code className="language-mermaid">{code}</code></pre>
      {drawn.status === 'error' && <p role="alert" className="text-muted-foreground text-xs">{drawn.message}</p>}
    </div>
  );
}
