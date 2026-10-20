// hv-kit: a screen's clicks, declared in its markup ("Interactions" in design.md). One copy per design folder, loaded by every screen of
// it with <script src="hv-kit.js" defer>, so a screen's behaviour is attributes the designer edits, never a script of its own.
//   data-hv-set="name=value"  sets data-name on <html>, the screen's state its CSS reacts to; the controls holding it get aria-current
//   data-hv-toggle="id"       shows or hides #id; data-hv-open="id" shows it; data-hv-close hides #id, or the layer it sits in
//   data-hv-layer             a dialog, or with ="popover" a menu that also closes on a click outside it; Escape closes either
//   data-hv-pick              selects within its [data-hv-group]; the group's data-hv-label="id" takes the pick's text
//   data-hv-switch            flips aria-checked and data-state
(() => {
  const root = document.documentElement;
  // The design pane owns data-theme and data-tweak-*: a screen's own state never overwrites them
  const RESERVED = /^(theme$|tweak-)/;

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
    for (const trigger of document.querySelectorAll(`[data-hv-toggle="${CSS.escape(target.id)}"]`)) {
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
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    for (const layer of document.querySelectorAll('[data-hv-layer]:not([hidden])')) show(layer, false);
  });
  mark();
})();
