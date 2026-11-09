## What and why

<!-- What this changes, and the issue it fixes (Fixes #123). -->

## How it was checked

<!-- The tests you added or ran (npx vitest run --maxWorkers=2 ...), and a live run on a real source if it changes a measurement. -->

## Checklist

- [ ] A test fails without this change and passes with it
- [ ] `npm run typecheck` and `npm test -- --maxWorkers=2` pass
- [ ] `npm run bundle` run and `dist/framelens.mjs` committed (and `npm run build:extension` for changes in `extension/`)
- [ ] New numbers carry the right evidence label (`measured`, `derived`, `inferred`)
- [ ] A changed measurement is checked against ground truth (`scripts/benchmark.mjs`; `docs/ACCURACY.md` regenerated, never edited by hand)
- [ ] No new way around logins, bot checks or other access control (design principle 7)
- [ ] A line in `CHANGELOG.md` under "Unreleased" if users will notice the change
- [ ] No version bumps (those happen at release)
