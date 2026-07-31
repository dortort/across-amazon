# Interface mockups

Three interactive UI/UX directions for the extension, in one self-contained page.

```bash
open mockups/index.html      # macOS
xdg-open mockups/index.html  # Linux
```

No build step, no dependencies, no network access. Everything is inline.

## The directions

| | Direction | Surface | Thesis |
| --- | --- | --- | --- |
| A | **Ledger** | 760×540 popup (today's footprint) | Show the whole table. Sortable columns, a delta against the source page, an expandable cost stack per row. |
| B | **Verdict** | 400×560 popup | Answer first: "buy from Germany, save $50.94." Ranking underneath, breakdown one tap away in a sheet. |
| C | **Cockpit** | Chrome side panel, 400px | Make the run visible. Markets stream through opening → searching → matching → reading, bars land as they resolve, extraction log stays available. |

## What is simulated

All three read the same fixture: one source product on `amazon.com` shipping to the US, nine target
marketplaces, and a deliberate spread of outcomes so every state is reachable.

| Market | Outcome |
| --- | --- |
| DE, UK, CA, AU | `OK` — cheapest is DE |
| IT | `OK` at 76% match confidence, flagged for manual checking |
| JP | `DESTINATION_MISMATCH` |
| FR | `UNAVAILABLE` |
| ES | `PARSE_FAILED` |
| MX | `NO_CONFIDENT_MATCH` — hidden by default, surfaced on request |

Statuses mirror `ComparisonStatus` in `src/shared/types.ts`. The run timing mirrors the real
sequential per-market extraction in `src/background/orchestrator.ts`, compressed to ~4s so the
progress states are watchable. FX is a fixed ECB snapshot rather than a live fetch, so the three
directions always show identical figures.

Prices are illustrative and are not real Amazon listings.
