// Where an experiment pins its plugin's inputs (#459): <experiment>/plugin/source (a copy of assets/plugin) and <experiment>/plugin/custom
// (a copy of the custom store). One module, so the route that pins (store.ts) and the run that reads the pin (run-home.ts) name the same
// folders. It imports nothing of src/benchmark/, so neither import makes a cycle.
import { join } from 'node:path';
import { customRoot } from '../item-sources.js';

const PIN_DIR = 'plugin';
const SOURCE_DIR = 'source';

/** The pin read as a custom store's home: versionDir(pinHome(dir), key, version) is <dir>/plugin/custom/<origin>/<name>/<version>. */
export const pinHome = (dir: string): string => join(dir, PIN_DIR);
export const pluginTrees = (dir: string): { source: string; custom: string } => ({ source: join(pinHome(dir), SOURCE_DIR), custom: customRoot(pinHome(dir)) });
