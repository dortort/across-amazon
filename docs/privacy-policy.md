# Across Amazon privacy policy

Effective date: 2026-10-20

Across Amazon is a Chrome extension that compares the delivered price of the Amazon product you are viewing with the same product on other Amazon stores. This policy explains what it reads, what it keeps, where it connects and who receives what.

## What the extension reads

The extension reads pages only on the ten Amazon stores it supports (amazon.com, amazon.ca, amazon.com.mx, amazon.co.uk, amazon.de, amazon.fr, amazon.it, amazon.es, amazon.co.jp and amazon.com.au), and only when you use it:

- **The page you are on.** When you open the popup, it checks whether the current tab is one of those stores. If it is, it looks for a product on that page and reads its Amazon product number (ASIN), title, brand, selected variant, image, price, shipping and import fees, and the page's address.
- **Your delivery destination as Amazon shows it.** It reads the country Amazon delivers to on that page, and the text of Amazon's "Deliver to" box. If you are signed in to Amazon, that text can include your first name and a town and postcode.
- **The other stores' pages.** When you press the check button, it opens the other stores' product and search pages in background tabs and reads the same product details from them, plus the delivery destination each one shows.
- **Other sellers' offers.** During a check, when a product page shows no price but offers "See All Buying Options", whether it is the page you are on or a page in a background tab, the extension asks that same store, from that page and with your Amazon session, for its list of other sellers' new offers, as Amazon's button does with its "New" filter, page by page up to three pages. From the answer it reads each offer's condition, item price, delivery price and the names of its seller and of whoever dispatches it. It keeps only the offer it quotes, with those two names, in the result of the check.

To set a store's delivery country (see below), it loads that store's "Choose your location" form, as Amazon's own "Deliver to" box does. If you are signed in, Amazon's form can list your saved addresses; the extension takes only the form's security token and its list of countries from it, and keeps nothing else.

On a store page that is not a product page, such as your orders or account pages, it finds no product and keeps nothing. It never reads other websites, your orders, your account details, your passwords or your cookies.

## What it stores, and for how long

Everything is kept in the extension's local storage in your browser:

| What | How long |
| --- | --- |
| Your settings: which stores to check and the display currency | Until you change them or remove the extension |
| The result of each finished check: the product details listed above (including the "Deliver to" text and the full address of the product page, which can include the Amazon search that led you to it), each store's prices, the seller and dispatcher names of any offer quoted from another seller, and the exchange rates used | Reused for 30 minutes. An older result is deleted only when exactly the same check is run again; otherwise it stays until you remove the extension or clear its storage |
| Each day's exchange rates | Reused for that UTC day; kept until you remove the extension or clear its storage |

Nothing it stores is sent to the developer or to anyone else.

## Network requests

The extension connects to:

- **The Amazon stores listed above.** It loads their product and search pages in background tabs. On a product page that shows no price but offers "See All Buying Options", it also requests that store's list of other sellers' offers from the page itself. These requests are made by your browser with your own Amazon session, as if you had opened the pages yourself. The pages it opens are found from the product number and from the links on Amazon's own search results and product pages. Like any visit, each page also loads whatever Amazon's own pages load, such as Amazon's image and script servers and any other services those pages call.
- **Amazon's image servers**, to show the product picture in the popup. The picture's address is the one on the product page you are on.
- **The European Central Bank** (www.ecb.europa.eu), to download its daily exchange rates. This normally happens once per UTC day; if the download fails, it is tried again on the next check.
- **Frankfurter** (api.frankfurter.dev), for the same rates, only when the European Central Bank's feed cannot be loaded.

The exchange rate requests carry no information about you or the product. Like any web request, they let those servers see your IP address.

## Who receives your data

The extension does not sell your data. The only recipients are the services listed under "Network requests", and each receives only what its request needs.

The Amazon stores receive, with your own Amazon session:

- **Your destination country**, in the store's own "Choose your location" request (see below).
- **The product's ASIN**, in the addresses of the product pages it opens.
- **The product's ASIN and the parameters Amazon puts on a product page for its "See All Buying Options" list** (such as a seller or the search that led to the page), in the request for that list, with a filter for new offers and a page number. It is sent from that product page, the page you are on or a background tab, only to the same store.
- **The product's title, brand, model number and selected variant (such as colour or size)**, as the search terms in the addresses of the search pages it opens.

Because these requests carry your Amazon session, Amazon can link them to your account if you are signed in. The pages it opens also load whatever Amazon's own pages load, as any visit does.

Amazon's image servers receive the address of the product picture, which identifies the picture, not you. The European Central Bank and Frankfurter receive only a request for the day's exchange rates, which carries nothing about you or the product. Like any web request, each of these lets that server see your IP address.

Nothing is sent to the developer or to anyone else.

## Changes it makes on Amazon and in your browser

So that every store quotes delivery to the same place, the extension may set each other store's delivery location to the country shown on the page you started from. It does this in your own browser session, with the same request Amazon's "Choose your location" box makes, and leaves the store set that way afterwards. Only a country is set, never a name, town, postcode or address. Your saved addresses, cart and orders are not touched, and nothing is ever bought. You can change a store's location back at any time in its "Deliver to" box.

The pages it opens are ordinary visits: they appear in Chrome's history and, if you are signed in to Amazon, may appear in your Amazon browsing and search history and influence its recommendations.

## What the extension does not do

- It has no analytics, telemetry, advertising or tracking, and no server of its own.
- It does not sell your data, and it sends nothing to anyone other than the services described above.
- It does not use your data for anything other than comparing prices for you.

Across Amazon's use of data complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Deleting your data

Removing the extension from Chrome deletes everything it stored. To clear its storage without removing it, open `chrome://extensions`, turn on Developer mode, click "service worker" under Across Amazon, and run `chrome.storage.local.clear()` in the console that opens.

Removing the extension does not change back any Amazon store's delivery location; change it in that store's "Deliver to" box. It also does not remove the visits it made from Chrome's history or from your Amazon history; clear those in Chrome and on Amazon.

## Changes to this policy

If this policy changes, the new version will be published at this address with a new effective date.

## Contact

Questions and bug reports go through [the support page](https://across-amazon.dortort.dev/support/), which also explains how to report a security issue privately.
