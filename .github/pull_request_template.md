Closes #

## Summary

<!-- One or two sentences: what changes and why. -->

## Changes

<!-- Grouped by area. -->

## Test plan

- [ ] `pnpm test`: <!-- result -->
- [ ] Manual checks: <!-- steps, or N/A -->

## Screenshots

<!-- For UI changes; otherwise N/A. -->

## Checklist

- [ ] TypeScript `strict` holds and no `any` was introduced
- [ ] Every relative import ends in `.js`
- [ ] The reducer in `src/orchestrator.ts` does not mutate
- [ ] No `execFile` call gained a shell string
- [ ] No token, absolute home path or account name in code, tests or logs
- [ ] Every new UI string exists in English and Portuguese in `src/ui/i18n.ts`
- [ ] Colour is used only for status (see `docs/agent/design-system.md`)
- [ ] No retired name from `docs/glossary.md`

<details>
<summary>Walkthrough</summary>

<!-- The whole walkthrough, when there is one; otherwise delete this block. -->

</details>
