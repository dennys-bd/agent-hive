// The dashboard's view state (#484): its per-viewer UI state (layouts, sizes, stage filters, the last workspace, each workspace's view of the
// Activities tab #779, each native view's grouping and columns #756, the base each file's changes compare against #668, the pinned
// repositories #757), kept in the Hive's home and read and written through GET /view-state and POST /view-state/:key. Not a setting and not
// the orchestrator's State. Pure, no Node import: the UI imports it through a relative path, so nothing from node:fs reaches the bundle.
export const VIEW_KEYS = ['dockLayout', 'stageFilters', 'centerLayouts', 'consoleHeight', 'splitEdge', 'lastWorkspace', 'activitiesView', 'projectViews', 'changesBase', 'repositories'] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];
/** Values are opaque here: each UI module parses its own. */
export type ViewState = Partial<Record<ViewKey, unknown>>;
/** What one key's value may serialise to (256 KiB): far above any layout, far below express.json's limit. */
export const VIEW_VALUE_MAX_BYTES = 262_144;

export const isViewKey = (value: unknown): value is ViewKey => VIEW_KEYS.some((key) => key === value);
