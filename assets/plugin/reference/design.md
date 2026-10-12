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
- Layout at 1280, 768 and 390 px with no horizontal scroll and no clipped text.
- Touch targets at least 44 by 44 px at 390 px; Operate's density applies at 1280 px.
- No fixed widths that break narrow screens.
- Colours come from tokens; dark and light themes both keep contrast.
- Every state the spec names is present.
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
- States are sections of the one file, one after another: one `<section>`
  per state (empty, loading, error, filled…), `id="state-<name>"`, headed by
  the state's name, so the pane shows them together and each state is easy
  to find.
- An alternative direction the user asked for is its own file,
  `<screen>.<variant>.hv.html` (`a`, `b`…).
- Lays out at 1280, 768 and 390 px wide.
- Real copy in the product's own words and languages; never lorem ipsum.
- Scripts only show states and interactions: no `fetch`, `XMLHttpRequest`
  or `WebSocket`.
- No secret, token or absolute home path in a screen or the handoff: the
  handoff may be posted to a public issue.

### The check

Run from the docs repository, `<folder>` the design folder, quoted. Both
commands print nothing:

```bash
grep -nEi "(src|srcset|href|action|formaction|poster|data)\s*=\s*[\"']?\s*(https?:|file:|//|/)|(url|image-set)\(\s*[\"']?\s*(https?:|file:|//|/)|@import\s+[\"']?\s*(https?:|file:|//|/)|import\s*\(?\s*[\"'](https?:|//)|\.\.[/\\]|http-equiv\s*=\s*[\"']?refresh|sendBeacon|EventSource|window\.open|fetch\s*\(|XMLHttpRequest|WebSocket" "<folder>"/*.hv.html
find "<folder>" -type l
```

Each file also holds `<!doctype html>`, `<html`, `<head`, `</head>`, `<body`,
`</body>` and `</html>`, in that order.

### Seeing it rendered

Only after the check passes, and only when a browser is at hand: a browser
tool the session offers, or a Chromium on `PATH`
(`command -v chromium chromium-browser google-chrome`). Screenshot into a
`mktemp -d` folder outside the repositories, with no network and a throwaway
profile, never `--no-sandbox`:

```bash
chromium --headless --no-first-run --user-data-dir="$tmp/profile" --host-resolver-rules="MAP * ~NOTFOUND" --window-size=390,2400 --screenshot="$tmp/<screen>-390.png" "file://<absolute path>"
```

One round at 1280 and 390 px, then delete the folder. Without a browser, say
the screens were not seen rendered.
