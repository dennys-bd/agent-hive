import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftFrom } from '../src/ui/lib/settings-form.js';
import { SETTINGS_SECTIONS, unsavedKeys, unsavedSections } from '../src/ui/lib/settings-sections.js';

const saved = draftFrom({ configured: false, home: '/home', language: 'pt', agents: [{ agent: 'claude', available: true }] });

test('unsavedKeys lists the draft keys that differ from the saved draft; a value typed back is no change (#510)', () => {
  assert.deepEqual(unsavedKeys(saved, saved), []);
  assert.deepEqual(unsavedKeys(saved, { ...saved, branch: 'x/{id}', theme: 'dark' }).sort(), ['branch', 'theme']);
  assert.deepEqual(unsavedKeys(saved, { ...saved, branch: saved.branch }), [], 'typed back');
  const workspaces = saved.workspaces.map((p) => ({ ...p, setup: 'RUN pnpm i' }));
  assert.deepEqual(unsavedKeys(saved, { ...saved, workspaces }), ['workspaces'], 'a row edit is one change of its key');
});

test('unsavedSections names each section with a change once, in the nav order (#510)', () => {
  assert.deepEqual(unsavedSections(['theme', 'branch', 'trustedDomains', 'consoleLines']), ['execution', 'app']);
  assert.deepEqual(unsavedSections(['workspaces']), ['workspaces']);
  assert.deepEqual(unsavedSections(['shortcuts', 'rules', 'stages', 'prefix']), ['flow', 'rules', 'shortcuts']);
  assert.deepEqual(unsavedSections(['onClose']), ['app']);
  assert.deepEqual(unsavedSections(['notifications']), ['app'], '#199');
  assert.deepEqual(unsavedSections(['defaultAgent']), ['execution'], '#516');
  assert.deepEqual(unsavedSections(['fileIcons']), ['app'], '#754');
  assert.deepEqual(unsavedSections(['sidebarsPerView']), ['app'], '#821');
  assert.deepEqual(unsavedSections(['signals']), ['rules'], '#727');
  assert.deepEqual(unsavedSections([]), []);
});

test('the editor section (#749, #780) follows app in the nav and owns the editor draft key', () => {
  assert.deepEqual(SETTINGS_SECTIONS.slice(4, 7), ['app', 'editor', 'shortcuts']);
  assert.deepEqual(unsavedSections(['editor', 'theme']), ['app', 'editor']);
});

