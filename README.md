# Across Amazon

Across Amazon is a Chrome MV3 extension that compares delivered product cost across Amazon marketplaces by combining item price, shipping, and import fees shown on Amazon pages.

## Capabilities

- User-triggered comparison from extension popup only
- Top-10 marketplace support: US, CA, MX, UK, DE, FR, IT, ES, JP, AU
- Conservative product matching with confidence filtering
- Sequential cross-market extraction via temporary inactive tabs
- Daily FX normalization (ECB primary, Frankfurter fallback)
- Local-only short-lived caching (30 minutes)

## Popup

The popup follows the "Verdict" design: one answer first, detail on demand.

- Idle: the product on the current page, its delivered price, and a single call to action
- Running: a progress dial with the current phase (opening, searching, matching, reading) and a chip per finished marketplace
- Done: a verdict card (save, stay here, cheapest, or nothing found), every marketplace ranked by delivered total with the delta against the current page, low-confidence matches flagged, and failed marketplaces folded into an accordion
- Sheet: item, shipping, import fees, delivered total and the converted amount for any marketplace, with a confidence note
- Settings: display currency and marketplaces to check, saved immediately and shared with the options page

## Tech stack

- Vite + React + TypeScript
- Chrome Extension Manifest V3
- Vitest + JSDOM unit, component (React Testing Library) and orchestrator integration tests
- Playwright functional, design and visual regression e2e tests
- GitHub Actions CI (e2e runs in the official Playwright container)

## Development setup

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

## Testing

- `pnpm test` runs unit tests for shared helpers and parsers, component tests for every popup view, and orchestrator tests that drive the real service worker and extractors against HTML fixtures through a chrome mock
- `pnpm test:e2e` runs Playwright against the popup served by Vite with a mocked chrome API: functional flows, computed-style design assertions, and screenshot snapshots
- Screenshot snapshots are platform specific. macOS snapshots are generated locally; Linux snapshots used by CI are regenerated with `pnpm test:e2e:linux-snapshots`, which runs the suite inside the same Playwright Docker image as CI

## Load extension in Chrome

1. Run `pnpm build`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select `dist`

## Project structure

- `src/background`: service worker, orchestration, FX service
- `src/content`: source/search/product extractors
- `src/shared`: message/types, matching, money, storage
- `src/popup`: extension popup UI (`view-model.ts` holds the pure ranking and copy logic, `components/` the views)
- `src/options`: options/settings page
- `tests/unit`: unit, component and orchestrator tests with HTML fixtures under `tests/fixtures`
- `tests/e2e`: Playwright popup flows, design assertions and snapshots
- `scripts`: maintenance scripts such as Linux snapshot regeneration

## Guardrails

- No checkout automation
- No credential handling
- No scheduled crawling
- No long-term price-history storage
- Purchases always occur on official Amazon product pages
