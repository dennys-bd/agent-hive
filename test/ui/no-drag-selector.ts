import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The window header is an Electron drag region (#583) and Electron subtracts every no-drag box from it wherever the box sits in the DOM, so a
// portalled layer needs the rule itself or its clicks over the header drag the window (#908). The selector is read from the stylesheet, so
// the test fails when the rule or one of the primitives' markers goes away.
const css = readFileSync(resolve(process.cwd(), 'src/ui/index.css'), 'utf8');
// Anchored on the popper wrapper, so another no-drag rule elsewhere in the file is never taken for this one
const rule = /([^{}]*\[data-radix-popper-content-wrapper\][^{}]*)\{[^{}]*-webkit-app-region:\s*no-drag[^{}]*\}/.exec(css);
export const selector = (rule?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

// A layer counts when the element, or an ancestor, is a no-drag box: the ancestor's box covers the element
export const noDrag = (el: Element | null): boolean => selector !== '' && el?.closest(selector) != null;
