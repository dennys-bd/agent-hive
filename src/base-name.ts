// A path's last segment (#641), shared by the daemon (workspaceNameFor) and the UI, which has no node:path: so no node:* import here.
// By shape, never by platform: the UI knows no platform, and every caller holds a path whose separator it does not control. Empty segments
// drop, so a trailing separator still names the folder; nothing left answers the input.
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? path;
}
