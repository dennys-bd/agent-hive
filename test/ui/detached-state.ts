import type { SettingsInfo, State } from '../../src/types';

// What the mocked useHiveState and useSettingsInfo answer in the DetachedWindow tests (#553): a box a test sets before rendering
export const box: { state?: State } = {};
export const INFO: SettingsInfo = { configured: true, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }] };
export const hiveState = () => ({ state: box.state, effective: undefined, connected: true, tick: 0 });
export const settingsInfo = () => ({ info: INFO, error: undefined, reload: async () => INFO });
