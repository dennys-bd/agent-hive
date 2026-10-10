// Which links may leave the app for the OS (#780): a language server's hover is a new source of links, and shell.openExternal hands any
// scheme to the system (file:, a custom app's handler), so only these open.
const OPENABLE = new Set(['http:', 'https:', 'mailto:']);

export function isOpenableExternal(url: string): boolean {
  try {
    return OPENABLE.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
