# Design rules

What `hive:designer` writes by and `hive:design-reviewer` checks by. Where the
repository's design system says otherwise, the design system wins. The sources
are credited in `CREDITS.md`.

## Direction

Settle these before the first line:

- Purpose: the job the screen does.
- Audience: who repeats this workflow, and what they must scan first.
- Tone: one explicit word (utilitarian, dense, calm, editorial, technical…).
- One memorable detail that makes the result feel intentional.
- Constraints: accessibility, responsiveness, the existing design system.

With a design system, the direction is the design system's: use its tokens,
components, icons and copy rules before inventing any.

- Match the direction to the domain. A tool used daily is dense, quiet and
  scannable; only a launch or editorial piece is expressive.
- Make the usable screen the first thing seen, never a marketing section.
- Set a clear hierarchy: one primary action, few secondary, the rest quiet.
- Use one spacing scale and one type scale, with obvious steps.
- Keep colour restrained: a neutral base and an accent for action and state.
- Put colours, sizes and spacing in CSS variables so states stay coherent.
- Give boards, grids, toolbars and counters stable dimensions that do not
  shift when a label or a hover appears.
- Use motion only to clarify a state change.
- Use real assets when the screen shows images, charts or media.

## Craft floor

The minimum every screen meets. Check it on the built result.

- Contrast: body and placeholder text at least 4.5:1, large text 3:1.
- Tint secondary text from the surface's hue or the foreground, never plain grey.
- Shadows carry an offset and a soft blur; a zero-offset coloured halo is decoration.
- Group tightly, separate generously, put more space above a heading than below.
- Keep body text to a 65-75 character measure, with balanced headings.
- Run the real copy at every width and fix what overflows or overlaps.
- Show hover, focus, active, disabled, loading, error and empty states.
- Show real content, and controls that read as working.
- Keep keyboard focus visible, with a logical order.
- Theme the browser's own parts from the palette: selection, caret, scrollbars,
  focus rings, tabular numerals.
- Write copy in the product's own words: controls name their action; errors
  name the problem and the recovery.
- Cover every requirement of the spec, findable within seconds.

## Bans

- Purple gradients and decorative blobs.
- Oversized cards, and cards inside cards.
- Same-size icon, heading and text cards as the page structure.
- The hero-metric template: big number, small label, supporting stats.
- Vague hero copy, and stock-like atmospheric media.
- Describing a feature in the UI when the control can speak for itself.
- A kicker or eyebrow above a heading.
- Section numbers (01 / 02 / 03) unless the sequence carries information.
- Gradient text; emphasis comes from weight or size.
- Glass and blur as decoration.
- A coloured border-left or border-right above 1px on cards, rows or alerts.
- Hard offset shadows (`4px 4px 0`) outside an actually neobrutalist world.
- Sparklines, progress rings and rounded rectangles standing in for content.
- Monospace as a costume; use it for code, data and measurement only.
- A display face in labels, buttons or data.
- Emoji or Unicode glyphs standing in for icons; draw icons in one stroke and weight.
- A modal for a task that needs neither interruption nor protected focus.
- One decorative style everywhere when the domain calls for restraint.
- Hiding the product's main object or workflow behind generic sections.
- Light or dark chosen by category; choose it from the use scene.
- Emblems of militarism, supremacy or hate movements as decoration.

## Refinement preserves, redesign replaces

- The brief wins: honour pinned fonts, palettes, eras and materials.
- An update, sync, normalize or refine changes only what the run is for.
- Keep the incumbent identity, behaviour, copy and everything outside scope.
- Never replace factual copy or add claims on your own; propose them in the handoff.
- Redesign only when asked; then treat the old look as an anti-reference and
  keep product truth, content and function.
- Never split the difference by polishing the look a redesign discarded.
- Verify in bounded passes: build fully, inspect once in a batched round, fix
  everything in one batch, then stop.

## Operate and Read

The mode names what success looks like for the visitor. Choose it from the
surface, not the product.

- Operate: the visitor completes a task (tools, dashboards, editors, settings).
  Scanability, consistency and familiar affordances outrank expression.
- Read: the visitor understands something (docs, guides, changelogs). Structure
  for comprehension first.
- Persuade and Experience (marketing, showcases) are named only as out of the
  Hive's usual scope.

Operate:

- Make density a virtue: many rows and labels where the task needs them.
- Keep one component vocabulary across screens; the same action looks the same.
- Show system state at all times; give every action a keyboard path.
- Use one sans family; a fixed rem scale with 1.125-1.2 steps, no fluid sizes.
- Use the accent for primary actions, selection and state only.
- Give every component default, hover, focus, active, disabled, loading and error.
- Prefer skeletons to centred spinners; make empty states teach the interface.
- Keep transitions at 150-250 ms, only for state; no page-load choreography.
- Reach for inline and progressive disclosure before a modal.
- Never reinvent standard affordances (scrollbars, form controls, dialogs).

Read:

- Hold prose to a 65-75 character measure.
- Set a steady vertical rhythm and a clear heading hierarchy.
- Make navigation and the place within the document obvious.

## Audit

Technical checks of what is measurable. Report; do not fix.

- Accessibility at WCAG AA: contrast 4.5:1 for text, 3:1 for large text and UI parts.
- Every control has a label or accessible name; inputs have labels.
- Nothing is said by colour alone; headings nest in order; use real buttons.
- Focus is visible, tab order is logical, nothing traps the keyboard.
- Motion honours `prefers-reduced-motion` while keeping the state change visible.
- Layout at each width the screen declares in `viewports` (`desktop` 1280,
  `tablet` 768, `mobile` 390 px) with no horizontal scroll and no clipped
  text; a screen that declares none, at its own width.
- Touch targets at least 44 by 44 px at 390 px when the screen declares
  `mobile`; Operate's density applies at 1280 px, or at the screen's own width.
- No fixed widths that break narrow screens.
- Colours come from tokens; dark and light themes both keep contrast.
- Every state the spec names is present.
- Every option of every tweak renders without clipping or overlap.
- No URL or absolute path outside the screen's folder (`## The .hv.html format`).
- The screen is specific to this product, not interchangeable with another.
- Rank each finding: what breaks the task, AA compliance or the layout is
  `blocking`; polish only is `advisory`.
- Name the evidence: rendered at which width, or read from the CSS.

## Critique

The design review, with a review checklist folded in as questions.

- Does the first view say what the product, workflow or object is?
- Does the hierarchy support scanning and repeated use?
- Does type fit its container without overlapping neighbours?
- Do colours keep contrast without collapsing into one hue?
- Are familiar icons used for familiar actions?
- Do boards, grids, toolbars and tiles keep stable dimensions?
- Do assets carry the subject rather than fill space?
- Does motion help orientation rather than mask slowness?
- Does it match the design system and the patterns earlier designs set, or say why not?
- Heuristics: system status visible; the product's words; undo and escape;
  consistency; error prevention; recognition over recall; shortcuts for experts;
  minimal design; errors that name the recovery; help in place.
- Cognitive load: at most four visible options per decision point; no memory
  bridges between screens; no jargon; no visual noise.
- Walk the screen as a hurried expert, a first-timer, a keyboard and
  screen-reader user, and a distracted mobile user.
- Return strengths, then the three to five issues that matter most, each with
  why it matters and a concrete fix.

## Polish

Refine, part 1. Preserve the visual world; never a hidden redesign.

- Fix in order: blocked tasks and misleading state, missing states, flow and
  hierarchy drift, visual inconsistency, leftovers.
- Match neighbouring screens' terms, disclosure and save behaviour.
- Align to the spacing scale, optically as well as mathematically.
- Keep same-role type identical across screens; test wrapping and long copy.
- Use semantic tokens with the same colour meaning in every theme.
- Keep icon family, stroke and size coherent.
- Give each control its states and a visible focus.
- Test long, missing and empty content.
- Keep terms, capitalisation and punctuation consistent; do not change claims.
- Remove debug leftovers, dead styles and duplicated blocks.

## Distill

Refine, part 2. Remove what does not earn its place.

- Name the one goal of the screen and keep only what serves it.
- Remove repeated information and headings that restate their text.
- Allow one primary action, few secondary, the rest hidden or tertiary.
- Hide the rarely needed behind a clear entry point.
- Cut borders, shadows and backgrounds that serve neither hierarchy nor function.
- Flatten nesting; use spacing and alignment instead of cards.
- Use one or two colours plus neutrals, and few type sizes and weights.
- Cut copy in half; use the active voice and plain words.
- Never drop a needed function, a label, or the hierarchy.

## Normalize

Align screens to the design system and to the patterns earlier designs set.

- Read the design system and the other designs' handoffs first.
- Replace one-off values and shapes with the system's tokens and components.
- Unify variations of the same concept; keep apart things that differ in intent.
- Extract a pattern only when it repeats three times with the same intent.
- When a screen settles a pattern the design system lacks or contradicts,
  change the design-system file and list it in the handoff.
- Never change code.

## The .hv.html format

A screen is one HTML document the Hive's design pane renders in a sandboxed
frame, with no network.

- One file per screen: `<!doctype html>`, `<html lang="…">`, `<head>` with
  `<meta charset="utf-8">` and
  `<meta name="viewport" content="width=device-width, initial-scale=1">`,
  `<body>`, each closed.
- Self-contained: CSS in `<style>`, scripts in `<script>`, images as inline
  SVG or `data:` URLs, or files inside the screen's own folder by a relative
  path without `..`. No `http:`, `https:`, `file:`, `//` or absolute path in
  any attribute, `url(`, `image-set(`, `@import` or `import`. Fonts are a system stack, or the design
  system's font with a system fallback; never a font CDN.
- One screen's combinations (a layout, an option on or off, a count) are
  tweaks of the file ("Tweaks" below); states meant to be seen side by side
  are sections: one `<section>` per state (empty, loading, error, filled…),
  `id="state-<name>"`, headed by the state's name.
- A window screen (a fixed-size app window) is drawn whole at its natural
  size, in its section: no card, border or padding around it, no `overflow`
  that clips or scrolls it. The design pane shows it at its own size; only
  its canvas scrolls.
- Theme tokens live under `:root` (dark) and `:root[data-theme="light"]`; a
  new screen starts from the skeleton ("The skeleton" below).
- An alternative direction the user asked for is its own file,
  `<screen>.<variant>.hv.html` (`a`, `b`…).
- Declares `viewports` ("Tweaks" below) only when it lays out at 1280, 768
  and 390 px wide (a responsive page); a window screen declares none and is
  shown at its own size.
- Real copy in the product's own words and languages; never lorem ipsum.
- Scripts only show states and interactions: no `fetch`, `XMLHttpRequest`
  or `WebSocket`. Clicks go through the kit ("Interactions" below).
- No secret, token or absolute home path in a screen or the handoff: the
  handoff may be posted to a public issue.

### Tweaks

A screen declares its tweaks in one block in `<head>`:

```html
<script type="application/json" id="hv-tweaks">
{
  "viewports": ["desktop", "mobile"],
  "layout": { "options": ["board", "list"], "default": "board", "group": "view" },
  "auto": { "type": "boolean", "default": true },
  "title": { "type": "text", "default": "Fluxo" },
  "gap": { "type": "number", "default": 8, "min": 0, "max": 24, "step": 4 }
}
</script>
```

- Names match `[a-z][a-z0-9-]*`; at most 32 tweaks.
- `viewports` is reserved, not a tweak: a non-empty list of unique names
  among `"desktop"` (1280 px), `"tablet"` (768 px) and `"mobile"` (390 px),
  the widths the screen lays out at. The design pane always opens the screen
  in `natural`, its own width and height, and shows a switch with the
  declared ones; a screen without the key shows only `natural`. It has no
  control and no `data-tweak-*` attribute, and does not count toward the 32.
- An enum is `{options, default}`, its options unique, non-empty strings.
  Boolean, text (up to 200 characters) and number (`min`, `max`, `step`
  optional) carry a `type`. Every default fits its own definition; `group`
  names the section of the pane's tweaks panel a tweak sits in.
- The design pane shows a control per tweak, sets each value on `<html>` as
  `data-tweak-<name>` (booleans `"true"` or `"false"`, numbers as decimals),
  then fires `hv:tweak` on `window` with `{name, value}`.
- CSS reacts by attribute: `:root[data-tweak-layout="list"] .board { display: none; }`.
  A script listens to `hv:tweak` and also reads the attribute at load.
- The default state needs no attribute: without the pane (a screenshot)
  nothing sets them.

### The skeleton

`${CLAUDE_PLUGIN_ROOT}/reference/skeleton.hv.html` holds the required tags,
an `hv-tweaks` block declaring only the three `viewports` (a responsive
page: drop the key for a window screen), the links to the folder's
`hv-tokens.css` and `hv-kit.js`, and one section. Copy it for a new screen.
Every design folder holds one copy of
`${CLAUDE_PLUGIN_ROOT}/reference/hv-tokens.css` (the theme tokens under
`:root` and `:root[data-theme="light"]`) and of
`${CLAUDE_PLUGIN_ROOT}/reference/hv-kit.js`, shared by all its screens:
copy both in with the folder's first screen, never edit the kit, and with a
design system, its tokens replace those of `hv-tokens.css`. A token one
screen alone needs stays in that screen's `<style>`.

### Interactions

A screen's clicks are declared in its markup and run by `hv-kit.js`; a
screen writes no click script of its own. The kit's attributes:

- `data-hv-set="<name>=<value>"` on a control sets `data-<name>` on
  `<html>`: the screen's state, such as the section a sidebar picks, which
  the screen's CSS shows and hides by attribute
  (`:root[data-view="flow"] #flow`). Write the first state on `<html>`
  itself; the kit marks the controls holding the state with
  `aria-current`. `theme` and `tweak-*` are the design pane's and ignored.
- `data-hv-toggle="<id>"` shows or hides `#<id>`, `data-hv-open="<id>"`
  shows it, `data-hv-close` hides `#<id>` or, empty, the layer it sits in.
- `data-hv-layer` marks a dialog, `data-hv-layer="popover"` a menu or
  popover, which also closes on a click outside it or on a pick inside it.
  Escape closes either. A layer starts `hidden`.
- `data-hv-pick` selects within its `data-hv-group` (`aria-selected`); a
  group's `data-hv-label="<id>"` writes the pick's text into `#<id>`, as a
  select shows its value.
- `data-hv-switch` flips a switch's `aria-checked` and `data-state`.

A state the user picks from the pane is a tweak; a state the screen's own
controls reach is `data-hv-set`, never both. Behaviour the kit cannot
express, such as text typed into a filter that narrows a list, goes in a
short `<script>` of the screen, and the handoff names it.

### The check

Run from the docs repository, `<folder>` the design folder, quoted. It prints
nothing and exits 0 when the folder passes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-hv.mjs" "<folder>"
```

It reports, one line each: what reaches outside the folder or the network
(`http:`, `https:`, `file:`, `//` or an absolute path in an attribute,
`url(`, `image-set(`, `@import` or `import`; `..`; a refresh; `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `window.open`);
a symbolic link; `<!doctype html>`, `<html`, `<head`, `</head>`, `<body`,
`</body>` or `</html>` missing or out of order; an `hv-tweaks` block that is
not JSON or breaks "Tweaks"; a script or stylesheet loaded by a relative
path that is not in the folder, such as a missing `hv-kit.js`.

### Seeing it rendered

Only after the check passes, and only when a browser is at hand: a browser
tool the session offers, else the first found of a Chromium on `PATH`
(`command -v chromium chromium-browser google-chrome`), the system Chrome
(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS),
and Playwright's newest `chromium-*` (under `PLAYWRIGHT_BROWSERS_PATH`, else
`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux).
Screenshot into a `mktemp -d` folder outside the repositories, with no
network and a throwaway profile, never `--no-sandbox`:

```bash
chromium --headless --no-first-run --user-data-dir="$tmp/profile" --host-resolver-rules="MAP * ~NOTFOUND" --proxy-server=http://127.0.0.1:9 --proxy-bypass-list="<-loopback>" --window-size=390,2400 --screenshot="$tmp/<screen>-390.png" "file://<absolute path>"
```

Screenshot each enum option once, and each boolean the other way: copy the
screen into the temporary folder with `data-tweak-<name>="<value>"` added to
its `<html>` tag, one copy per value, the other tweaks at their default.

One round at each width the screen declares (`desktop` 1280, `tablet` 768,
`mobile` 390 px, as `--window-size`), or at its own width when it declares
none, then delete the folder. Without a browser, say the screens were not
seen rendered.
