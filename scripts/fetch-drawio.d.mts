/** Types for scripts/fetch-drawio.mjs, which test/fetch-drawio.test.ts imports at run time (#955). */
export interface DrawioPin { version: string; url: string; sha256: string }
/** A file entry of the war (folders are skipped); bytes() inflates it and checks its size and CRC-32 on demand. */
export interface ZipEntry { name: string; bytes(): Buffer }
export interface FetchDrawioOptions {
  root: string; // the package root: vendor/drawio/ goes under it
  env?: NodeJS.ProcessEnv; // HIVE_SKIP_DRAWIO=1 returns at once; default process.env
  download?: (url: string) => Promise<Buffer>; // default: Node's fetch, read whole; a non-2xx status throws with the URL and the status
  pin?: DrawioPin; // default DRAWIO_PIN
}
export declare const DRAWIO_PIN: Readonly<DrawioPin>;
export declare const PRUNED: readonly string[];
export declare function readZip(buffer: Buffer): ZipEntry[];
export declare function prunedEntries(entries: readonly ZipEntry[]): ZipEntry[];
export declare function fetchDrawio(options: FetchDrawioOptions): Promise<void>;
