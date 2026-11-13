import { fileURLToPath } from 'node:url';
import { shellQuote } from './shell-init.js';

// The command shims (#800): one template, assets/bin/command-shim, rendered per first word of a line with a Command Semaphore into
// <home>/command-shims/<word>, first on every pty's PATH, as the agents' shims are rendered into <home>/bin (#696).

const COMMAND = '__HIVE_COMMAND__';

/** `assets/bin/command-shim` in the Hive's own checkout, resolved from dist/src/ as shimSource is. */
export const commandShimSource = (): string => fileURLToPath(new URL('../../assets/bin/command-shim', import.meta.url));

/** The shim as written for `word`: quoted, since a first word lineWords takes can still hold a # or a ! (it never holds a quote). */
export const renderCommandShim = (template: string, word: string): string => template.replaceAll(COMMAND, () => shellQuote(word));
