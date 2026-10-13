import type { TweakSchema } from '../../design-tweaks';

// A design pane's tweaks (#241): the frame's hv-tweaks block, parsed here since the frame's content is untrusted, and the values the mounted
// pane holds for its file, like the theme: nothing is stored. The frame forgets them on every load, so they go again after every ready.

export type TweakBlock = { status: 'none' } | { status: 'invalid' } | { status: 'ok'; schema: TweakSchema };
