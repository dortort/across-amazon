# Using the popup

Across Amazon answers one question about the product page you are on: is it cheaper, delivered to your address, from another Amazon marketplace? This guide walks through every state of the popup.

> [!NOTE]
> The screenshots use illustrative fixture data from [`tests/fixtures/popup.ts`](../tests/fixtures/popup.ts): a Sony WH-1000XM5 bought from amazon.com for delivery to the United States, with exchange rates dated 2026-07-30. The prices, fees, rates and confidence scores are made up for the example. They are not real Amazon prices. Regenerate the images with `pnpm docs:screenshots` (see [Testing](testing.md#docs-screenshots)).

## Where it works

Open the popup on a product page on any of the ten supported marketplaces:

| Code | Marketplace | Domain | Currency |
| --- | --- | --- | --- |
| US | United States | amazon.com | USD |
| CA | Canada | amazon.ca | CAD |
| MX | Mexico | amazon.com.mx | MXN |
| UK | United Kingdom | amazon.co.uk | GBP |
| DE | Germany | amazon.de | EUR |
| FR | France | amazon.fr | EUR |
| IT | Italy | amazon.it | EUR |
| ES | Spain | amazon.es | EUR |
| JP | Japan | amazon.co.jp | JPY |
| AU | Australia | amazon.com.au | AUD |

A check covers every marketplace switched on in [Settings](#6-settings) except the one you are on, so by default it covers the other nine. Nothing runs until you click the button.

## 1. Idle

<img src="screenshots/idle.png" width="360" alt="Idle popup showing the Sony headphones at $399.99 on amazon.com and a Check 9 other Amazons button">

When the popup opens it reads the page you are on and shows:

- the product title and image
- the variant it detected (here "Black") and the item price on the current marketplace
- one button, **Check 9 other Amazons**. The number is how many marketplaces will be checked.
- a time estimate of about 3 seconds per marketplace, and, when the page's destination country is known, a note that each marketplace's delivery location may be [set to your destination](#your-destination-and-the-other-marketplaces) and is left that way after the check

While the page is still being read, the popup shows "Reading this page…" in place of the product card.

The footer reads "ECB daily rates" until a check has loaded exchange rates. After that it shows the date of the rates in use.

## 2. Running

<img src="screenshots/running.png" width="360" alt="Running popup with a progress dial at 4 of 9, Searching France, and chips for Canada, Mexico, United Kingdom, Germany and France">

Each marketplace is first looked up by your product's ASIN, Amazon's own product identifier, and searched only when it does not list that ASIN. Its pages are read in background tabs that open without taking focus and close as soon as they have been read. Before a marketplace's first page is read, its delivery location is [set to your destination](#your-destination-and-the-other-marketplaces). The popup shows:

- **The dial**: how many marketplaces are finished out of the total (4/9 here).
- **The current step** for the marketplace in progress: *Opening tab*, *Searching*, *Matching product* or *Reading cost stack*, followed by its domain. A marketplace that lists your product's ASIN goes straight from *Opening tab* to *Reading cost stack*.
- **A chip per finished marketplace**, in the order they were checked. A green chip shows the delivered total in your display currency. A chip with "—" means that marketplace could not be compared. The [issues list](#5-issues) explains why once the check is done. The blue chip with "…" is the marketplace being checked now.

**Stop checking** cancels the run and closes any background tabs it opened. Closing the popup does not stop a check: it finishes in the background and its result is [cached](#what-the-numbers-mean). Reopen the popup on the same tab to follow its progress.

## 3. Verdict

<img src="screenshots/done.png" width="360" alt="Verdict card reading Save $50.94: buy from Germany for $349.05 delivered, 13% less than the $399.99 you would pay here">

The card at the top gives the answer:

- **Cheapest delivered to United States** names the destination the prices were quoted for: the country of Amazon's "Deliver to" box on the page you are on, any country Amazon delivers to, Switzerland included. When the page shows a town and a postcode instead, the destination is that marketplace's own country. When the country cannot be read at all, the card says "your address". See [your destination and the other marketplaces](#your-destination-and-the-other-marketplaces) for how every other marketplace is made to quote that destination.
- **Save $50.94** is the difference between the cheapest delivered total ($349.05 from Germany) and the delivered total on the page you are on ($399.99).
- **13% less** is that saving as a share of what you would pay here.
- **Item, shipping and import fees included.** says what the cheapest total covers. When that marketplace's page showed no import fees for your destination, the card reads "Item and shipping included. Amazon showed no import fees, so duties may still be due on delivery." instead: the saving then leaves out any duties collected on delivery, while the page you are on may include them.
- **Open on amazon.de** opens that product page in a new tab. You review it and buy there, on Amazon. The extension never adds to cart or checks out.

### The ranked list

<img src="screenshots/done-list.png" width="360" alt="Ranked list of marketplaces from Germany at $349.05 to Australia at $438.72, with the United States marked as the page you are on">

Below the card, **Every marketplace** ranks every marketplace that returned a delivered price, cheapest first. The page you are on is part of the list, so you can see where it ranks.

Each row shows:

- **Left**: the marketplace and its delivered total in its own currency, formatted the way that marketplace formats prices (for example `323,19 €` on amazon.de), followed by "incl. shipping & import", or "incl. shipping, import fees not shown" when the page showed no import fees for your destination.
- **Right, bold**: the same delivered total converted to your display currency (the column header shows which, here USD).
- **Right, below**: the delta against the page you are on. A green `−$50.94` is that much cheaper. A brown `+$38.73` is that much more expensive. The row for the current page reads "the page you are on".

The cheapest row is highlighted. Click any row to open its [breakdown sheet](#4-breakdown-sheet).

### What "Check match" means

Every listing in the list passed the product-matching threshold. A listing found under your product's ASIN is the same product by Amazon's own identifier, so it counts as an exact match and never shows the pill. A listing found by searching is scored, not certain: its confidence combines how closely the listing's title, brand and variant match your product with how cleanly its product page could be read. A listing from your product's brand with the same model number (for example WH-1000XM5) counts as a close title match even when the marketplace words its title differently, but it still scores below 90%, so it carries the pill. When that confidence is below 90%, the row (and the verdict card, if it is the cheapest) shows a **Check match** pill. In the example Italy scored 76% because its listing title does not state the colour.

Before a listing found by searching is ranked, its product page is checked for the variant it shows. When the page shows another colour, pack or size than yours, the extension switches to your variant through the page's own variant selector, or reports the marketplace as "No confident match" when the page does not offer it.

Open the listing and confirm it is the same product, variant and condition before you buy. Listings that score below the matching threshold are never ranked. They appear under [issues](#5-issues) as "No confident match".

## 4. Breakdown sheet

<img src="screenshots/sheet.png" width="360" alt="Germany breakdown sheet: item price 279,00 €, shipping 12,99 €, import fees deposit 31,20 €, delivered total 323,19 €, roughly $349.05 at today's rate">

Clicking a row slides up its breakdown, in the marketplace's own currency:

| Line | Meaning |
| --- | --- |
| Item price | The price on the product page. |
| Shipping to United States | Shipping to your destination, or "Free". |
| Import fees deposit | The import fees Amazon quotes for your destination, "—" when there are none, or "Not shown" when the page showed no import fees for your destination. |
| Delivered total | Item + shipping + import fees. |
| Roughly | The delivered total converted to your display currency at the day's rate. |

The note under the lines says how sure the match is, for example "We are 91% sure this is the same product — title, brand and variant all line up." A low-confidence match gets an amber note instead. When the check switched that marketplace's delivery location to your destination, a line below it says so, for example "Delivery location set to Switzerland". **Open on amazon.de** opens the listing. The sheet for the page you are on shows the product and variant and a **Close** button. Press Escape or click outside the sheet to close it.

## 5. Issues

<img src="screenshots/issues-open.png" width="360" alt="Expanded list of 4 marketplaces that could not be compared: Mexico, France, Spain and Japan">

Marketplaces that could not be compared are folded under **N marketplaces could not be compared** at the bottom of the results. Expand it to see why:

| Status | What happened |
| --- | --- |
| No confident match | The marketplace does not list your product's ASIN and no search result scored above the matching threshold, or the closest listing is another variant that its page does not offer in yours, so nothing is compared rather than risking the wrong product. |
| Delivered total not quotable | Amazon did not show the item price or the shipping for your destination, for example because the item cannot be shipped there. The note names the destination ("Amazon did not show a delivered price to Switzerland."), and when Amazon gives a reason it repeats it, for example: Amazon says: “This item cannot be shipped to your selected delivery location.” |
| Could not read the page | The product page could not be read, or the tab failed to load in time. |
| Could not set delivery location | The marketplace kept quoting delivery to another place because its delivery location could not be switched to your destination, for example because it does not offer that country. The note says which: "This store does not offer delivery to Switzerland." or "Could not set this store's delivery location to Switzerland, so its price is for another place." |

**Check again** at the bottom starts a new check.

## 6. Settings

<img src="screenshots/settings.png" width="360" alt="Settings view with currency choices USD, EUR, GBP and JPY and a grid of marketplaces to check">

The gear in the top bar opens settings. The ✕ closes them and takes you back to where you were. Changes are saved as soon as you make them. They are the same settings as on the extension's options page.

- **Show prices in** chooses the display currency. The first choice is the currency of the marketplace you are on, and it follows that marketplace when you shop on another one. The others are fixed choices among USD, EUR, GBP and JPY. A currency picked on the options page (which also offers CAD, MXN and AUD) shows up here too.
- **Marketplaces to check** turns individual marketplaces on or off. The marketplace you are on is not listed because it is always the reference. Fewer marketplaces make the check faster.

## When nothing is cheaper

<img src="screenshots/stay.png" width="360" alt="Stay here verdict: nothing came in under the $299.99 you would pay on amazon.com">

When no marketplace beats the page you are on, the card turns slate and reads **Stay here**. In this example the amazon.com price is $299.99. The page you are on is the highlighted top row, and every other row shows how much more it would cost.

The card has two other answers:

- **The cheapest delivered total, with no saving.** This shows when the price on the page you are on could not be read. The popup still names the cheapest marketplace but has nothing to compare it with.
- **No delivered price.** None of the marketplaces could quote a delivered price to your destination.

If the check itself fails (for example the exchange rates could not be loaded, or the extension's background service did not answer), the card reads **Couldn't compare** with the reason.

## When you are not on an Amazon product page

<img src="screenshots/not-on-amazon.png" width="360" alt="Popup asking to open an Amazon product page, with the check button disabled">

On any other site, or on an Amazon page that is not a product page (search results, the cart), the popup asks you to open an Amazon product page and the button stays disabled.

## Your destination and the other marketplaces

A delivered price only compares with yours when every marketplace quotes the same destination. So before the check reads a marketplace, it makes that marketplace deliver to the country of the page you are on, and leaves it that way.

- **How.** On the first page the check opens on a marketplace, it reads the country that marketplace delivers to from the fields Amazon renders on the page. When that is already your destination, nothing is sent. Otherwise the extension makes the same two requests Amazon's own "Deliver to" box makes, from that page: it reads the location form, then submits your country. The page is then opened again so the price it reads is quoted for your destination.
- **What changes.** Each marketplace's delivery location becomes your country, the same as picking it in that marketplace's "Choose your location" box. The extension never restores the previous location, so your own tabs on that marketplace show the new one after their next reload. The marketplace you are on is never changed. Only a country is ever set, never a town, a postcode or an address, and your saved addresses, cart and checkout are not touched.
- **Only once.** A marketplace is set at most once per check, and a marketplace that already delivers to your destination costs no request. After the first check, every later check finds them already set.
- **When it cannot.** A marketplace whose location form does not offer your country (amazon.com.au offers few countries), or that cannot be set to an address in its own country without a postcode, or whose change Amazon refuses, keeps quoting its previous place. It is listed under [issues](#5-issues) as "Could not set delivery location" and is never ranked, because its price is for another place.
- **Country, not address.** When the page you are on shows a town and a postcode (an address in that marketplace's own country), the other marketplaces are set to that country, so their quotes are for the country rather than your exact address.

## What the numbers mean

- **Delivered total** = item price + shipping to your destination + import fees deposit, as quoted on the Amazon product page, in the currency the page shows. If Amazon displays a total that is higher than that sum, the displayed total is used. Amazon quotes import fees for an address abroad only on some pages (amazon.com shows them in its AmazonGlobal details). When a page prices the item and the delivery but shows no import fees, the delivered total is the item price plus shipping, any import charges collected on delivery are not included, and the verdict card, the row and the breakdown sheet say so.
- **Conversion**: totals are converted to your display currency with the European Central Bank daily reference rates (with [Frankfurter](https://frankfurter.dev/) as a fallback when the ECB feed is unavailable). Rates are fetched at most once a day, and the footer shows their date. Amazon charges you in the marketplace's own currency, so your card or bank's rate decides what you actually pay.
- **Delta**: the converted delivered total minus the converted delivered total of the page you are on. The page you are on is always the reference.
- **Saving percentage**: the saving divided by the delivered total on the page you are on.
- **Confidence**: how sure the extension is that a listing is the same product. See [What "Check match" means](#what-check-match-means).
- **30-minute cache**: a finished check is stored in the extension's local storage, keyed by product, variant, destination, the "Deliver to" text on the page you are on and the set of marketplaces checked. **Check again** within 30 minutes returns that result instantly instead of opening the background tabs again. After 30 minutes a fresh check runs.
