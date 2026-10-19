# Testing

| Layer | Tool | Where | Command |
| --- | --- | --- | --- |
| Unit | Vitest + JSDOM | `tests/unit/*.test.ts` | `pnpm test` |
| Component | Vitest + React Testing Library | `tests/unit/popup/*.test.tsx` | `pnpm test` |
| Orchestrator integration | Vitest + JSDOM | `tests/unit/orchestrator.test.ts` | `pnpm test` |
| Build | Vitest + Vite | `tests/unit/build.test.ts` | `pnpm test` |
| End-to-end functional | Playwright | `tests/e2e/verdict.spec.ts` | `pnpm test:e2e` |
| Design and visual | Playwright | `tests/e2e/verdict-design.spec.ts` | `pnpm test:e2e` |

Static checks run alongside: `pnpm lint` (ESLint) and `pnpm typecheck` (`tsc --noEmit` over `src`, `tests`, `scripts` and the config files).

## Vitest suites

`pnpm test` runs every file under `tests/unit` once. `pnpm test:watch` keeps Vitest running and re-runs on change.

```bash
pnpm test                                  # everything
pnpm test tests/unit/view-model.test.ts    # one file
pnpm test -t "computeVerdict"              # tests whose name matches
```

- **Unit tests** cover the pure code: price parsing, delivered totals and conversion (`money.test.ts`), matching (`matching.test.ts`), result ordering (`comparison.test.ts`), the FX service and its manifest host permissions (`fx-service.test.ts`), the extractors against the HTML fixtures in `tests/fixtures/{source,search,product}/<MARKET>.html` (`parsers.test.ts`, `product-extractor.test.ts`), and the popup's view-model (`view-model.test.ts`). Two more fixture folders hold trimmed captures of live Amazon pages: `tests/fixtures/search-live/<MARKET>.html` has the current search result cards (one ad and three organic results each, in the layout Amazon serves today), and `tests/fixtures/product-live/` has product pages seen from a delivery address in Switzerland. The search extractor is tested against both card layouts, and `matching.test.ts` runs the live cards through matching.
- **Component tests** render the real popup `App` with React Testing Library and a `vi`-mocked `chrome` (`tests/unit/popup/harness.tsx`): idle, running, done, sheet, settings and focus behaviour.
- **Orchestrator tests** boot the real service worker and run the real extractors against the HTML fixtures through a chrome mock that simulates tabs, script injection, storage and the ECB feed. They cover a full run, delivered totals, progress messages, the ASIN lookup and its search fallback, the cache, cancellation, tab loading, failures, the baseline, a popup that has closed and `LOAD_SOURCE` errors. The mock serves a product fixture for `/dp/<ASIN>` only when the marketplace carries that ASIN: its own fixture ASIN, or the source ASIN for the marketplaces a test lists in `sourceAsinOn`. A marketplace listed in `redirectAsinOn` answers with its own product instead, and every other `/dp/` request gets Amazon's not-found page (`tests/fixtures/product/not-found.html`).
- **The build test** runs a production Vite build into a temporary directory, checks that every content script is a single IIFE with no module syntax, and injects each one twice into the same JSDOM isolated world. See [why content scripts are IIFE-wrapped](architecture.md#why-content-scripts-are-iife-wrapped).

The popup suites share their example data with the e2e suites through `tests/fixtures/popup.ts`.

## Playwright suites

The e2e tests load `popup.html` from the Vite dev server in Chromium at the popup's real size (400×560). `tests/e2e/harness.ts` installs a fake `chrome` API with `page.addInitScript` before the page loads:

- `chrome.tabs.query` returns an active tab whose URL is an amazon.com product page (or whatever the scenario sets, to test other pages).
- `LOAD_SOURCE` answers with the fixture source and baseline.
- `RUN_COMPARISON` records the request's `runId`. Progress and result messages are stamped with the popup's tab id and that `runId` before they are delivered, as the real background does, so the popup's run correlation is exercised.
- Requests to the Amazon image host are answered with an inline SVG, so no test touches the network.

Tests drive the run step by step with helpers such as `emitProgress(page, progressStep(scn, "DE", "MATCH"))` and `emitResult(page, resultPayload(scn))`.

```bash
pnpm exec playwright install chromium               # once per machine and Playwright version
pnpm test:e2e                                       # both specs
pnpm test:e2e tests/e2e/verdict.spec.ts             # one spec
pnpm test:e2e --grep "detail sheet"                 # tests whose title matches
PW_PORT=4201 pnpm test:e2e                          # use another port for the dev server
```

Playwright starts the dev server itself on `127.0.0.1:${PW_PORT:-4173}` and reuses one that is already running on that port, except on CI. Set `PW_SKIP_WEBSERVER=1` to skip starting a server, for example when you run `pnpm vite --host 127.0.0.1 --port 4173` yourself.

### Functional tests

`verdict.spec.ts` covers user flows: a full comparison, the detail sheet, the other verdicts, a low-confidence best match, an unreachable background, stopping a run, ignoring another tab's comparison, settings, the loading state, pages that are not Amazon product pages, focus management and keyboard use.

### Design and visual tests

`verdict-design.spec.ts` asserts computed styles rather than pixels where it can: the document is exactly 400×560 and never scrolls, colours and sizes of buttons, the verdict card and the ranked list, the progress dial's fill, the detail sheet's animation and reduced-motion behaviour, focus rings and toast geometry.

Its `visual snapshots` block compares full-popup screenshots of nine states against committed baselines: idle, running, done, done scrolled to the bottom, issues open, sheet, stay, settings and not on Amazon.

### Per-platform screenshot baselines

Fonts and anti-aliasing differ by operating system, so Playwright keeps one baseline per platform:

```
tests/e2e/verdict-design.spec.ts-snapshots/verdict-<state>-darwin.png   # macOS
tests/e2e/verdict-design.spec.ts-snapshots/verdict-<state>-linux.png    # Linux, used by CI
```

After an intentional visual change, regenerate both sets:

```bash
pnpm test:e2e tests/e2e/verdict-design.spec.ts --update-snapshots   # baselines for your own platform
pnpm test:e2e:linux-snapshots                                       # Linux baselines, needs Docker
```

`pnpm test:e2e:linux-snapshots` runs `scripts/update-linux-snapshots.sh`. It starts the official `mcr.microsoft.com/playwright:v<version>-noble` image, where `<version>` is the installed `@playwright/test` version, mounts the repository read-only and copies it into the container, installs dependencies, runs `playwright test --update-snapshots=all`, and copies the `*-snapshots` directories back into `tests/e2e`. Extra arguments go to `playwright test`, so `pnpm test:e2e:linux-snapshots tests/e2e/verdict-design.spec.ts` limits it to one spec. Review the new PNGs before committing them.

### The CI container must match Playwright

The `e2e` job in `.github/workflows/ci.yml` runs inside `mcr.microsoft.com/playwright:v1.58.2-noble`, and `@playwright/test` is pinned to exactly `1.58.2` in `package.json`, without a range. The image ships the browser builds for one Playwright release. If the package and the image drift apart, Playwright cannot find its browsers, or the Linux baselines stop matching what CI renders.

When you upgrade Playwright, in the same change:

1. Pin the new exact version of `@playwright/test` in `package.json`.
2. Change the container tag in `.github/workflows/ci.yml` to that version.
3. Run `pnpm test:e2e:linux-snapshots` (it picks up the new version) and your platform's `--update-snapshots`, and commit the new baselines.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests against `main`:

- **checks** (Ubuntu, Node 22): `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- **e2e** (the Playwright container): `pnpm test:e2e`. The Playwright report and test results are uploaded when it fails.

## Docs screenshots

The images in [`docs/screenshots`](screenshots) are produced from the real popup by `scripts/capture-screenshots.ts`:

```bash
pnpm docs:screenshots
```

The script starts the Vite dev server on a free port, loads `tests/e2e/harness.ts` through Vite so it uses the same chrome mock and fixture data as the e2e tests, routes the Amazon image host to an inline placeholder and blocks every other non-local request. It then drives Chromium to each state and saves a 400×560 screenshot at a device scale factor of 2 (an 800×1120 PNG):

| File | State |
| --- | --- |
| `idle.png` | Product loaded, ready to check |
| `running.png` | 4 of 9 marketplaces checked, France being searched |
| `done.png` | Save verdict |
| `done-list.png` | Results scrolled to the ranked list |
| `issues-open.png` | Issues expanded, scrolled to the bottom |
| `sheet.png` | Germany breakdown sheet |
| `stay.png` | Nothing cheaper than the page you are on |
| `settings.png` | Settings |
| `not-on-amazon.png` | A page that is not on Amazon |

Each state is checked before it is captured (for example the verdict must read "Save $50.94" and the dial "4/9"), and the capture fails if anything other than the popup's content area has scrolled. Re-running the script on the same machine produces identical files, so a diff in `docs/screenshots` means the popup changed. Fonts come from the operating system, so captures from different platforms differ slightly.

Run it after a change to the popup's appearance or copy and commit the updated PNGs with that change. It needs Playwright's Chromium (`pnpm exec playwright install chromium`) and a Node.js version that runs TypeScript natively: 22.18 or later, or 23.6 or later. It is not part of CI.
