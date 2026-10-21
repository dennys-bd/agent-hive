import { join } from 'node:path';
import { pluginSource } from '../src/hooks-settings.js';
import { createPluginRender } from '../src/plugin-render.js';
import { type AfterHost, tempDir } from './temp-dir.js';

/** The shipped plugin as the render delivers it to `workspace` with no value saved (#416): the folder a run reads its agents and skills
 * from. assets/plugin itself holds templates (agents/designer.md.liquid), which no agent reader lists. Throws with the render's log when an
 * item failed, so a broken shipped template fails the test that needed it. */
export async function renderedPlugin(t: AfterHost, workspace = 'a'): Promise<string> {
  const home = await tempDir(t, 'rendered-');
  const errors: string[] = [];
  const render = createPluginRender({ home, pluginSource: pluginSource(), log: { error: (line) => errors.push(line) }, env: { CODEX_HOME: join(home, 'codex') } });
  await render.write({ comb: { workspaces: [{ name: workspace, path: home }] } });
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return render.dir(workspace);
}
