// hv-kit: a screen's clicks and hovers, declared in its markup ("Interactions" in design.md). One copy per design folder, loaded by every screen of
// it with <script src="hv-kit.js" defer>, so a screen's behaviour is attributes the designer edits, never a script of its own.
//   data-hv-set="name=value"  sets data-name on <html>, the screen's state its CSS reacts to; the controls holding it get aria-current
//   data-hv-toggle="id"       shows or hides #id; data-hv-open="id" shows it; data-hv-close hides #id, or the layer it sits in
//   data-hv-layer             a dialog, or with ="popover" a menu that also closes on a click outside it; Escape closes either
//   data-hv-pick              selects within its [data-hv-group]; the group's data-hv-label="id" takes the pick's text
//   data-hv-switch            flips aria-checked and data-state
//   data-hv-hover="id"        shows #id (starts hidden) while the pointer or focus is on the control or on #id; hides 150ms after both are left
(() => {
  const root = document.documentElement;
  // The design pane owns data-theme and data-tweak-*: a screen's own state never overwrites them
  const RESERVED = /^(theme$|tweak-)/;
  // Long enough for the pointer to cross the gap between a link and its card without the card closing under it
  const HOVER_GRACE_MS = 150;
  const hideTimers = new Map();

  const parse = (spec) => {
    const at = spec.indexOf('=');
    const name = at > 0 ? spec.slice(0, at) : '';
    return /^[a-z][a-z0-9-]*$/.test(name) && !RESERVED.test(name) ? { name, value: spec.slice(at + 1) } : undefined;
  };

  function mark() {
    for (const control of document.querySelectorAll('[data-hv-set]')) {
      const state = parse(control.getAttribute('data-hv-set'));
      if (state && root.getAttribute(`data-${state.name}`) === state.value) control.setAttribute('aria-current', 'true');
      else control.removeAttribute('aria-current');
    }
  }

  function show(target, open) {
    if (!target) return;
    target.hidden = !open;
    for (const trigger of document.querySelectorAll(`[data-hv-toggle="${CSS.escape(target.id)}"], [data-hv-hover="${CSS.escape(target.id)}"]`)) {
      trigger.setAttribute('aria-expanded', String(open));
    }
  }

  const closePopovers = (except) => {
    for (const layer of document.querySelectorAll('[data-hv-layer="popover"]:not([hidden])')) if (!layer.contains(except)) show(layer, false);
  };

  function pick(item) {
    const group = item.closest('[data-hv-group]');
    if (!group) return;
    for (const other of group.querySelectorAll('[data-hv-pick]')) other.setAttribute('aria-selected', String(other === item));
    const label = document.getElementById(group.getAttribute('data-hv-label') ?? '');
    if (label) label.textContent = item.textContent;
  }

  function flip(control) {
    const on = control.getAttribute('aria-checked') !== 'true';
    control.setAttribute('aria-checked', String(on));
    control.setAttribute('data-state', on ? 'checked' : 'unchecked');
  }

  // Each kind acts on the closest marked element to the click, so a span inside a button counts as the button
  function act(target) {
    const near = (attr) => target.closest(`[${attr}]`);
    const byId = (attr) => document.getElementById(near(attr).getAttribute(attr));
    if (near('data-hv-set')) {
      const state = parse(near('data-hv-set').getAttribute('data-hv-set'));
      if (state) root.setAttribute(`data-${state.name}`, state.value);
      mark();
    }
    if (near('data-hv-toggle')) {
      const layer = byId('data-hv-toggle');
      show(layer, Boolean(layer?.hidden));
    }
    if (near('data-hv-open')) show(byId('data-hv-open'), true);
    if (near('data-hv-pick')) pick(near('data-hv-pick'));
    if (near('data-hv-switch')) flip(near('data-hv-switch'));
    const close = near('data-hv-close');
    if (close) show(document.getElementById(close.getAttribute('data-hv-close')) ?? close.closest('[data-hv-layer]'), false);
    // a choice made inside a menu closes it, as a menu does
    const menu = target.closest('[data-hv-layer="popover"]');
    if (menu && target.closest('[data-hv-pick], [data-hv-set]')) show(menu, false);
  }

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const opener = event.target.closest('[data-hv-toggle], [data-hv-open]');
    const opened = opener && document.getElementById(opener.getAttribute('data-hv-toggle') ?? opener.getAttribute('data-hv-open'));
    closePopovers(opened ?? event.target);
    act(event.target);
  });
  // The id of the hover pair (control or element) a node belongs to: either the control itself or the element a control points at
  function hoverId(node) {
    for (let at = node; at instanceof Element; at = at.parentElement) {
      if (at.hasAttribute('data-hv-hover')) return at.getAttribute('data-hv-hover');
      if (at.id && document.querySelector(`[data-hv-hover="${CSS.escape(at.id)}"]`)) return at.id;
    }
    return undefined;
  }

  function cancelHide(id) {
    clearTimeout(hideTimers.get(id));
    hideTimers.delete(id);
  }

  function hover(id, open) {
    cancelHide(id);
    if (open) show(document.getElementById(id), true);
    else hideTimers.set(id, setTimeout(() => show(document.getElementById(id), false), HOVER_GRACE_MS));
  }

  // A move between the control and its element is not a leave: relatedTarget says where the pointer or focus went
  for (const [type, open] of [['pointerover', true], ['focusin', true], ['pointerout', false], ['focusout', false]]) {
    document.addEventListener(type, (event) => {
      const id = hoverId(event.target);
      if (id && (open || hoverId(event.relatedTarget) !== id)) hover(id, open);
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const control of document.querySelectorAll('[data-hv-hover]')) {
      const id = control.getAttribute('data-hv-hover');
      cancelHide(id);
      show(document.getElementById(id), false);
    }
    for (const layer of document.querySelectorAll('[data-hv-layer]:not([hidden])')) show(layer, false);
  });
  mark();
})();
