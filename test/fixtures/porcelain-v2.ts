// `git status --porcelain=v2 -z` lines for tests (#502): only what parseStatus reads is meaningful, the modes and hashes are filler
const MODES = '100644 100644 100644';
const HASH = '0'.repeat(40);

export const ordinary = (xy: string, path: string): string => `1 ${xy} N... ${MODES} ${HASH} ${HASH} ${path}`;
/** A rename or copy: its entry, then its old path as the next NUL entry. */
export const renamed = (xy: string, path: string, from: string): string[] => [`2 ${xy} N... ${MODES} ${HASH} ${HASH} R100 ${path}`, from];
export const unmerged = (xy: string, path: string): string => `u ${xy} N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} ${path}`;
export const untracked = (path: string): string => `? ${path}`;
export const ignoredEntry = (path: string): string => `! ${path}`;
export const head = (name: string): string[] => [`# branch.oid ${HASH}`, `# branch.head ${name}`];
/** The -z output: every entry NUL-terminated, the trailing empty entry included. */
export const statusText = (...entries: (string | string[])[]): string => [...entries.flat(), ''].join('\0');
