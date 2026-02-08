# Across Amazon

Across Amazon is a Chrome MV3 extension that compares delivered product cost across Amazon marketplaces by combining item price, shipping, and import fees shown on Amazon pages.

## Capabilities

- User-triggered comparison from extension popup only
- Top-10 marketplace support: US, CA, MX, UK, DE, FR, IT, ES, JP, AU
- Conservative product matching with confidence filtering
- Sequential cross-market extraction via temporary inactive tabs
- Daily FX normalization (ECB primary, Frankfurter fallback)
- Local-only short-lived caching (30 minutes)

## Tech stack

- Vite + React + TypeScript
- Chrome Extension Manifest V3
- Vitest + JSDOM unit tests
- Playwright e2e tests
- GitHub Actions CI

## Development setup

```bash
pnpm install
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

## Load extension in Chrome

1. Run `pnpm build`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select `dist`

## Project structure

- `src/background`: service worker, orchestration, FX service
- `src/content`: source/search/product extractors
- `src/shared`: message/types, matching, money, storage
- `src/popup`: extension popup UI
- `src/options`: options/settings page
- `tests/unit`: unit and fixture parser tests
- `tests/e2e`: Playwright popup flow tests

## Guardrails

- No checkout automation
- No credential handling
- No scheduled crawling
- No long-term price-history storage
- Purchases always occur on official Amazon product pages
