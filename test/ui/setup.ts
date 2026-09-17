// jsdom lacks what Radix (Popover, Select) and cmdk touch at runtime.
import '@testing-library/jest-dom/vitest';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? ResizeObserverStub;
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? ((): void => {});
Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? ((): boolean => false);
Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? ((): void => {});
