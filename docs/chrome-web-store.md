# Chrome Web Store listing

Everything the Chrome Web Store developer dashboard asks for, drafted from the code. Paste each block into the field it names. Each claim comes from the code, with a pointer where it matters, so check the pointers again when the code changes.

## Store listing

### Name

```text
Across Amazon
```

From `name` in `manifest.json`.

### Summary

The dashboard takes the summary from `description` in `manifest.json` (132 characters at most). The current one is 74 characters:

```text
Compare delivered costs of equivalent products across Amazon marketplaces.
```

It is accurate but weak: "equivalent products" is vague, and it does not say what "delivered" covers or what the user gets. A proposed replacement, 118 characters:

```text
See which Amazon store delivers the product you are viewing for less: item, shipping and import fees, in one currency.
```

Adopting it means changing `description` in `manifest.json` and packaging a new zip. The dashboard reads the summary from the uploaded package.

### Detailed description

Plain text: the dashboard does not render Markdown.

```text
Across Amazon tells you whether the product you are looking at costs less, delivered to you, from another Amazon store.

Open a product page on a supported store, click the extension's icon and press "Check 9 other Amazons". The extension looks for the same product on the other stores, first by its ASIN (Amazon's product number) and otherwise by searching for its brand, model, title and selected variant. On each store it reads the item price, the shipping and any import fees quoted for your delivery destination, then ranks the stores by delivered total, converted to one currency.

Supported stores: United States, Canada, Mexico, United Kingdom, Germany, France, Italy, Spain, Japan and Australia. You can switch any of them off in the settings.

How it works
- Opening the popup only reads the product page you are on. Nothing else happens until you press the button.
- Each store's pages open briefly in background tabs that never take focus, and each tab closes as soon as it has been read. A check takes about 3 seconds per store.
- So that every price is quoted for the same place, each other store's delivery location may be set to the country in the "Deliver to" box of the page you started from. This is the same change as picking that country in the store's own "Choose your location" box. Only a country is set, never an address, and the store is left that way after the check. The store you started from is never changed.
- The pages it opens are ordinary visits: they appear in Chrome's history and, if you are signed in to Amazon, may appear in your Amazon browsing and search history.
- Prices are as shown on Amazon's own pages. When a store shows no import fees for your destination, the result says so, because duties may still be due on delivery.
- Exchange rates are the European Central Bank's daily reference rates, with Frankfurter as a fallback. Each store prices in its own currency; the rate your bank or Amazon's currency converter applies decides what you finally pay.
- A listing found by searching carries a confidence score. Open it and check it is the same product before you buy.

What it does not do
- It never adds to cart, checks out or buys anything. "Open" takes you to the listing, and you decide.
- It has no account, no analytics and no server of its own. Your settings and past results stay only in your browser; a result is reused for 30 minutes.

Not affiliated with or endorsed by Amazon.
```

Sources: the button label is `checkLabel` and the 3 seconds per store `SECONDS_PER_MARKET` in `src/popup/view-model.ts`; the ASIN lookup and search fallback are `compareMarket` in `src/background/orchestrator.ts`; the supported stores are `MARKETPLACES` in `src/shared/markets.ts`; the popup reads the page on open in `src/popup/App.tsx` (`requestSource`); the search terms are `buildSearchQueries` in `src/shared/matching.ts`; the location step is `src/content/location-setter.ts`; rates are `src/background/fx-service.ts`; the 30-minute reuse is `COMPARISON_TTL_MS` in `orchestrator.ts`.

### Category and language

| Field | Value |
| --- | --- |
| Category | Shopping (under Lifestyle) |
| Language | English. Every string in the popup and the options page is English. |

### Website

```text
Homepage URL: https://across-amazon.dortort.dev/
Support URL: https://across-amazon.dortort.dev/support/
```

Both pages are part of the website in `docs-site/`. The support page routes bug reports to GitHub Issues and security reports to private vulnerability reporting, so no email address is published.

## Privacy practices tab

### Single purpose

```text
Across Amazon compares the delivered price (item, shipping and import fees) of the Amazon product the user is viewing with the same product on other Amazon stores, so the user can see which store delivers it to them for less.
```

### Permission justifications

| Permission | Justification |
| --- | --- |
| `scripting` | The extension declares no content scripts, so nothing runs on a page by itself. When the user opens the popup on an Amazon product page, and when they start a check, the service worker injects the extension's own packaged scripts with `chrome.scripting.executeScript` into the user's Amazon tab and into the temporary background tabs it opens on the other Amazon stores. The scripts read the product, its price, shipping and import fees and the delivery destination, and set a store's delivery country when needed (`runScriptFile`, `readWindowValue` and `writeWindowValue` in `src/background/orchestrator.ts`). |
| `storage` | `chrome.storage.local` keeps the user's settings (enabled stores and display currency, key `settings:v1`), the result of a finished check so that checking again within 30 minutes returns it at once (keys `cmp:<hash>`), and the day's exchange rate table so the rates are normally downloaded once per UTC day (keys `fx:YYYY-MM-DD`). See `src/shared/storage.ts` and `src/background/fx-service.ts`. |

| Host permission | Justification |
| --- | --- |
| The ten Amazon stores (`www.amazon.com`, `.ca`, `.com.mx`, `.co.uk`, `.de`, `.fr`, `.it`, `.es`, `.co.jp`, `.com.au`) | Needed to inject the extension's scripts into Amazon product and search pages, both the page the user is on and the temporary background tabs opened on the other stores, and to let the popup see that the active tab is an Amazon store without the broader `tabs` permission. The location script runs inside a store's own page and sends that store's own "Choose your location" requests to the same store, so the store quotes delivery to the user's destination country. During a check, the product script on a product page that shows no price but offers "See All Buying Options" requests that store's list of other sellers' offers from the same origin, as Amazon's button does. The background tabs load Amazon pages whose addresses come from the product's ASIN and from links on Amazon's own search results and product pages; like any visit, those pages load Amazon's own image and script servers. |
| `www.ecb.europa.eu` | The service worker downloads the European Central Bank's daily euro reference rates (`eurofxref-daily.xml`) to convert each store's delivered total into one currency. The feed sends no CORS headers, so the request needs the host permission. Normally fetched once per UTC day; only a successful download is cached, so after a failure it is retried on the next check (`src/background/fx-service.ts`). |
| `api.frankfurter.dev` | Fallback for the same daily rates (`/v1/latest?base=EUR`), used only when the ECB feed cannot be loaded. Listing the host keeps the fallback independent of its CORS headers. |

### Remote code

```text
No, I am not using remote code.
```

Every script the extension runs is bundled in the package; `chrome.scripting.executeScript` only injects packaged files and functions, and nothing is fetched and evaluated at run time.

### Data usage

Tick these categories:

| Category | Tick | What the code handles |
| --- | --- | --- |
| Personally identifiable information | Yes | The text of Amazon's "Deliver to" box on the page the user is on (`#glow-ingress-line1`, `#glow-ingress-line2`, `#contextualIngressPtLabel`, read by `readDeliverTo` in `src/content/source-extractor.ts`). For a signed-in Amazon user this text can include their first name and a town and postcode. It is used to tell destinations apart in the cache key and to recognise the user's own postcode on other stores, it is stored inside the cached comparison, and it is never sent anywhere. The location script also loads each store's "Choose your location" form, which for a signed-in user can list their saved addresses; it takes only the form's token and country list from it (`readFormToken`, `offersCountry`) and keeps nothing. |
| Location | Yes | The destination country read from the page (an ISO code such as `CH`), and the town or postcode in the "Deliver to" text. The country code is sent to the other Amazon stores in their own location-change request (`setDeliveryLocation` in `src/content/location-setter.ts`) so they quote delivery there. |
| Web history | Yes | The popup reads the active tab's URL to tell whether it is an Amazon store page (`queryActiveTab` in `src/popup/App.tsx`), and the full URL of the product page a check started from, query string included, is stored in the cached comparison (`sourceUrl`, and again as the baseline's `productUrl`). An Amazon URL reached from a search can carry the user's own Amazon search terms (`keywords=`, `sprefix=`). Ticked conservatively: no browsing outside the Amazon stores is ever read. |
| Website content | Yes | Product titles, brands, selected variants, prices, shipping and import fee text, availability messages and image URLs read from Amazon product and search pages, kept in the cached comparison. The product's ASIN goes into the product page URLs opened on the other Amazon stores, and its title, brand, model number and selected variant tokens (such as colour or size) are the search terms in their search URLs (`buildSearchQueries` in `src/shared/matching.ts`, `buildSearchUrl` and `buildProductUrl` in `src/shared/markets.ts`). During a check, a product page that shows no price but offers "See All Buying Options", on the page the user is on or in a background tab, sends that store's own other-offers request to the same origin with the store session, carrying the ASIN and the page's all-offers parameters (`buildOtherOffersUrl` in `src/content/other-offers.ts`, `extractProductDataWithOffers` in `src/content/product-extractor.ts`); the answer's offer conditions, prices and seller and dispatcher names are read, and the quoted offer's seller and dispatcher names are kept in the cached comparison. |
| Health information | No | |
| Financial and payment information | No | Product prices are page content, not the user's financial data. No card, bank or order data is read. |
| Authentication information | No | No passwords, credentials or cookies are read. The location script reads the anti-forgery token Amazon puts on its own page and sends it back to the same store in its own location requests, exactly as Amazon's "Choose your location" box does, and never stores it. |
| Personal communications | No | |
| User activity | No | No clicks, keystrokes, scrolling or network traffic are monitored. |

Retention in `chrome.storage.local`, for the privacy policy and any reviewer question:

| Key | Contents | Lifetime |
| --- | --- | --- |
| `settings:v1` | Enabled stores, display currency | Until the user changes them or removes the extension |
| `cmp:<hash>` | Source product (including the "Deliver to" text and the full page URL), baseline, ranked results (including the seller and dispatcher names of an offer quoted from another seller), exchange rates of a finished check | Reused for 30 minutes. A stale record is deleted only when the same key is looked up again (`readComparisonCache` in `src/shared/storage.ts`), and the key changes with the settings and the "Deliver to" text, so most records stay until the extension is removed or its storage cleared |
| `fx:YYYY-MM-DD` | One day's exchange rate table | Reused for that UTC day; older tables are not deleted until the extension is removed or its storage cleared |

Nothing is sent to a server of the developer. The extension's own requests go to the Amazon stores, `www.ecb.europa.eu` and `api.frankfurter.dev` (the `fetch` calls in `src/background/fx-service.ts`, `src/content/location-setter.ts` and `src/content/product-extractor.ts`, and the tabs the service worker opens), and the popup loads the product image from the address on the source page, which is Amazon's image server (`extractImageUrl` in `src/content/source-extractor.ts`). The pages in the background tabs load whatever Amazon's own pages load. The only services that receive user data are the Amazon stores: the destination country in their location request, the ASIN in product page URLs and, with the page's all-offers parameters, in their other-offers request, and the title, brand, model number and selected variant in search URLs. The exchange rate and image requests carry nothing about the user beyond the IP address any request reveals, and the privacy policy says so.

Certify all three Limited Use statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Sending the destination country, ASIN and search terms to the Amazon stores is the transfer the single purpose needs, and the privacy policy names it.

### Privacy policy URL

The policy is published at https://across-amazon.dortort.dev/privacy/, which the website in `docs-site/` renders from [privacy-policy.md](privacy-policy.md) on every deploy, so the two cannot drift. Paste that URL in the privacy policy field.

## Test instructions for reviewers

The dashboard's "Test instructions" field (under Distribution), plain text:

```text
No account, sign-in or credentials are needed.

1. Open a product page for a widely sold electronics item that Amazon itself sells and ships, on www.amazon.com or www.amazon.co.uk. A popular charger, power bank or pair of headphones works well. The page must be a product page (URL containing /dp/), not search results.
2. Click the Across Amazon icon in the toolbar. The popup shows the product, its price on this store and a "Check 9 other Amazons" button. If the store knows the delivery country, a note says that the other stores' delivery location may be set to it and is left that way.
3. Press "Check 9 other Amazons". For about 30 seconds a background tab opens briefly on each other store and closes again; tabs never take focus. A dial shows the progress and "Stop checking" cancels the run and closes the tabs.
4. When it finishes, the card names the store with the cheapest delivered total (item + shipping + import fees, converted at the European Central Bank's daily rate) and the saving against the page you are on. The list ranks every store that quoted a price; click a row for its breakdown, and "Open on ..." opens that listing in a new tab. Nothing is ever added to a cart or bought.
5. Some stores will not compare, and that is expected. They are listed under "N marketplaces could not be compared" with the reason, most often "Delivered total not quotable" (that store does not ship this item to your delivery country) or "Could not set delivery location" (the store would not switch to, or does not offer, your delivery country). A store that shows a robot check may report "No confident match" or "Could not read the page".
6. Side effect: before reading a store, the extension sets that store's delivery location to the country of the page you started from, using the store's own "Choose your location" request. Only a country is set, never an address, and it is left that way. Open, for example, www.amazon.de afterwards and its "Deliver to" box shows that country. The store you started from is not changed. To undo it, pick another location in that store's "Deliver to" box. The pages the extension opens are ordinary visits, so they appear in Chrome's history and, for a signed-in Amazon user, in Amazon's browsing and search history.
7. Press "Check again" within 30 minutes and the same result returns at once from the local cache, with no tabs opened.
8. The gear icon in the popup (or the extension's options page) chooses the display currency and which stores to check.
```

## Store graphics

From `.omc/artifacts/store-assets/final/`:

| File | Size | Dashboard slot |
| --- | --- | --- |
| `store-icon-128.png` | 128 × 128 | Store icon |
| `screenshot-1.png` | 1280 × 800 | Screenshot 1: "Find the Amazon that delivers cheapest to you" (verdict and ranked list) |
| `screenshot-2.png` | 1280 × 800 | Screenshot 2: "See the full delivered cost before you buy" (breakdown sheet) |
| `screenshot-3.png` | 1280 × 800 | Screenshot 3: "Prices read live from each Amazon" (running view) |
| `screenshot-4.png` | 1280 × 800 | Screenshot 4: "Check 9 other Amazons with one button" (idle view) |
| `promo-small-440x280.png` | 440 × 280 | Small promo tile |
| `marquee-1400x560.png` | 1400 × 560 | Marquee promo tile |

## Pre-submission checklist

- [ ] Register the developer account and pay the one-time registration fee.
- [ ] Turn on 2-Step Verification for the Google account that owns the developer account; the dashboard will not publish without it.
- [ ] Make the Trader or Non-Trader declaration in the account settings, as required for the EU Digital Services Act.
- [ ] Set and verify the contact email in the account settings.
- [ ] Paste https://across-amazon.dortort.dev/privacy/ in the privacy policy field of the privacy practices tab, and the website and support URLs in the store listing.
- [ ] Run `pnpm package` and upload `release/across-amazon-<version>.zip` (the script refuses to package when `manifest.json` and `package.json` disagree on the version).
- [ ] Fill in the store listing, privacy practices and test instructions from this page, and upload the store graphics.
- [ ] Decide on the summary: keep the current `description` or adopt the proposed one before packaging.
- [ ] Decide on the icon and store graphics: the orange curved arrow under the globe can read as Amazon's smile logo, which a reviewer may take as implied endorsement. Reshaping or recolouring the arrow before submitting lowers that risk; keep the "Not affiliated with or endorsed by Amazon" line either way.
- [ ] Decide whether the privacy policy names the publisher, and with which name, before publishing it.
- [ ] Check that every pointer above still matches the code that was packaged.
