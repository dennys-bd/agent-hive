// jsdom lacks what Radix (Popover, Select) and cmdk touch at runtime.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest.config.ts has no `globals: true`, so Testing Library's own auto-cleanup (which looks for a
// global afterEach) never registers: without this, one test's render leaks into the next in the same file.
afterEach(() => { cleanup(); });

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? ResizeObserverStub;
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {});
Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? ((): boolean => false);
Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? ((): void => {});
