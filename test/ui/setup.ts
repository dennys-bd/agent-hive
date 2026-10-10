// jsdom lacks what Radix (Popover, Select) and cmdk touch at runtime.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { resetChecks } from '@/lib/check-session';
import { resetDiagnostics } from '@/lib/diagnostics-store';
import { resetSessions, setSocketFactory } from '@/lib/lsp-session';
import { resetViewState } from '@/lib/view-state';

// vitest.config.ts has no `globals: true`, so Testing Library's own auto-cleanup (which looks for a
// global afterEach) never registers: without this, one test's render leaks into the next in the same file.
afterEach(() => { cleanup(); });

// The view state (#484) is module state: a test's snapshot and pending posts never reach the next test
afterEach(() => { resetViewState(); });

// The lib measures and positions in a layout jsdom does not have; a plain host div proves the wiring and keeps the DOM shape
// (className on the host, children inside) the Flow tests walk through.
vi.mock('overlayscrollbars-react', async () => {
  const { createElement } = await import('react');
  return {
    OverlayScrollbarsComponent: ({ className, children }: { className?: string; children?: ReactNode }) =>
      createElement('div', { className, 'data-testid': 'os-host' }, children),
  };
});

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? ResizeObserverStub;
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {});
Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? ((): boolean => false);
Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? ((): void => {});
Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? ((): void => {});

// jsdom has no matchMedia: applyTheme (#296) and sonner's system theme read it. A light macOS that never changes, unless a test stubs its own.
window.matchMedia = window.matchMedia ?? ((query: string): MediaQueryList => ({
  matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
}));

// The language servers (#780) are module state: no test opens a real socket, and none sees another's sessions or diagnostics
beforeEach(() => { setSocketFactory(() => ({ send: () => undefined, close: () => undefined, onmessage: null, onclose: null })); });
afterEach(() => { resetSessions(); resetChecks(); resetDiagnostics(); });
