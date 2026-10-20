# Across Amazon

Across Amazon is a Chrome MV3 extension that compares delivered product cost across Amazon marketplaces. On an Amazon product page, it checks the same product on the other marketplaces and ranks them by delivered total (item price + shipping + import fees, as shown on Amazon pages) against the page you are on.

The website at https://across-amazon.dortort.dev has the privacy policy, the FAQ, the support page and how the permissions and data are used.

<p align="center">
  <img src="docs/screenshots/done.png" width="400" alt="Popup verdict: save $50.94 by buying the headphones from Germany for $349.05 delivered instead of $399.99 on amazon.com">
</p>

| Idle | Running | Breakdown |
| :---: | :---: | :---: |
| <img src="docs/screenshots/idle.png" width="260" alt="Idle popup with the product and a Check 9 other Amazons button"> | <img src="docs/screenshots/running.png" width="260" alt="Progress dial at 4 of 9 with a chip per checked marketplace"> | <img src="docs/screenshots/sheet.png" width="260" alt="Germany breakdown: item, shipping, import fees and delivered total"> |

<sub>Screenshots show the real popup with illustrative fixture data, not real prices.</sub>

## Documentation

- [Using the popup](docs/popup.md): every popup state, and what the delivered totals, deltas and "Check match" mean
- [Architecture](docs/architecture.md): how a comparison runs end to end, message correlation, cancellation and the module map
- [Testing](docs/testing.md): the test layers, visual baselines per platform, and regenerating the screenshots
- [Chrome Web Store listing](docs/chrome-web-store.md): the store listing, privacy practices, reviewer test instructions and submission checklist
- [Privacy policy](docs/privacy-policy.md): what the extension reads, stores and sends, and to whom

## Capabilities

- User-triggered comparison from the extension popup only
- Top-10 marketplace support: US, CA, MX, UK, DE, FR, IT, ES, JP, AU
- Finds the same product on each marketplace by its ASIN, falling back to a search by brand and model number, then by title
- Conservative product matching with confidence filtering, and a check that a listing found by search is your colour, pack and size
- Sequential cross-market extraction via temporary inactive tabs
- Sets each marketplace's delivery location to your destination before reading its price, and leaves it set
- Says when a delivered total leaves out import fees because the marketplace showed none for your destination
- Daily FX normalization (ECB primary, Frankfurter fallback)
- Local-only short-lived caching (30 minutes)

## Tech stack

- Vite + React + TypeScript, Chrome Extension Manifest V3
- Vitest + JSDOM unit, component (React Testing Library), orchestrator and build tests
- Playwright functional, design and visual regression tests
- GitHub Actions CI (e2e runs in the official Playwright container)

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test                      # Vitest: unit, component, orchestrator and build tests
pnpm test:e2e                  # Playwright against the popup served by Vite
pnpm test:e2e:linux-snapshots  # regenerate the Linux visual baselines in Docker
pnpm docs:screenshots          # regenerate docs/screenshots
pnpm build                     # production build into dist/
pnpm dev                       # rebuild dist/ on every change
```

See [Testing](docs/testing.md) for first-time Playwright setup and how the baselines work.

## Load extension in Chrome

1. Run `pnpm build`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select `dist`

## Package for the Chrome Web Store

Run `pnpm package`. It runs the production build and zips the contents of `dist` (without source maps) into `release/across-amazon-<version>.zip`, ready to upload to the Chrome Web Store Developer Dashboard. It fails if the `manifest.json` and `package.json` versions differ.

## Project structure

- `src/background`: service worker, orchestration, FX service
- `src/content`: source/search/product extractors and the delivery location setter
- `src/shared`: message/types, matching, money, storage
- `src/popup`: extension popup UI (`view-model.ts` holds the pure ranking and copy logic, `components/` the views)
- `src/options`: options/settings page
- `tests/unit`: unit, component, orchestrator and build tests with HTML fixtures under `tests/fixtures`
- `tests/e2e`: Playwright popup flows, design assertions and snapshots
- `scripts`: Linux snapshot regeneration and docs screenshot capture
- `docs`: user guide, architecture, testing and screenshots
- `docs-site`: the documentation website, built with Astro and deployed to GitHub Pages

## Guardrails

- No checkout automation
- No credential handling
- No change to your addresses: a marketplace's delivery location is set to a country, never to an address
- No scheduled crawling
- No long-term price-history storage
- Purchases always occur on official Amazon product pages
