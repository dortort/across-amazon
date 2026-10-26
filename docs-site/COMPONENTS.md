# Components and styles

How to write a page for this site without reading the component code. Every page lives in `src/pages/`, uses `Base`, and gets the header, footer, skip link, theme and meta tags from it.

## A page in five lines

```astro
---
import Base from "../layouts/Base.astro";
import PageIntro from "../components/PageIntro.astro";
---

<Base title="FAQ" description="Answers about delivered totals, import fees and Check match.">
  <PageIntro title="Frequently asked questions" lede="Short answers, with links to the details." />
  <div class="container page-body">
    <article class="prose">
      <h2 id="delivered-total">What is the delivered total?</h2>
      <p>Item price, shipping and import fees, as Amazon quotes them for your destination.</p>
    </article>
  </div>
</Base>
```

Keep one `h1` per page (`PageIntro` renders it). Use `h2` and `h3` below it, and give every `h2` and `h3` a kebab-case `id` so it can be linked.

Keep a word and the inline element next to it (`<a>`, `<em>`, `<strong>`, `{expression}`) on one source line, or add `{" "}`. A line break between them drops the space in the built page.

## Layout and components

### `Base` (`src/layouts/Base.astro`)

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `title` | string | required | Page name. The tab title becomes "title · Across Amazon"; a title that already contains "Across Amazon" is used as is. |
| `description` | string | the site description | Meta and social description. Write one plain sentence. |
| `noindex` | boolean | `false` | Adds `robots: noindex` and drops the canonical link. Only the 404 page uses it. |

The page content goes in the default slot, inside `<main id="main">`.

### `PageIntro` (`src/components/PageIntro.astro`)

The page heading block: the `h1` and an optional lede, inside a `.container`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `title` | string | required | The page `h1`. |
| `lede` | string | none | One or two sentences under the heading. |

Anything in the default slot renders under the lede, for example a `StoreButton`.

```astro
<PageIntro title="Support" lede="Start with the FAQ. If it does not answer your question, open an issue on GitHub." />
```

### `Shot` (`src/components/Shot.astro`)

A popup screenshot in a rounded frame with a border and shadow, optimised by `astro:assets`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `src` | `ImageMetadata` | required | An import from `src/assets/screenshots/`. |
| `alt` | string | required | What the screenshot shows. Reuse the alt text from the extension's popup guide. |
| `caption` | string | none | Plain-text caption under the frame. |
| `width` | `340`, `360` or `400` | `360` | Largest display width in CSS pixels, set by a size class (`shot-340`, `shot-360`, `shot-400`). Any other number snaps to the nearest of the three. The frame shrinks to fit narrower columns. |
| `priority` | boolean | `false` | Loads the image eagerly. Use it only for a screenshot visible without scrolling. |

For a caption with markup, put it in the default slot instead of `caption`. Any page that shows screenshots must say, in a caption or nearby, that the prices are illustrative.

```astro
---
import Shot from "../components/Shot.astro";
import sheetShot from "../assets/screenshots/sheet.png";
---

<Shot
  src={sheetShot}
  alt="Germany breakdown sheet: item price 279,00 €, shipping 12,99 €, import fees deposit 31,20 €, delivered total 323,19 €, roughly $349.05 at today's rate"
  width={340}
>
  <strong>Breakdown.</strong> Prices are illustrative.
</Shot>
```

### `Toc` (`src/components/Toc.astro`)

An "On this page" list of in-page links. Below 1080px it is a collapsed card that opens on tap, with rows at least 44px tall. From 1080px it is a sticky sidebar to the right of the content, with muted links.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `items` | `{ href: string; label: string }[]` | required | The links, in page order. Each `href` is an in-page anchor such as `#steps`. |
| `label` | string | `"On this page"` | The navigation landmark's name and the visible title. |

Put it as the first child of `.container.page-body`, before the `article`. The component turns that `.page-body` into the two-column layout on wide screens, so the page needs no layout CSS of its own. Every other child of `.page-body` stays in the left column.

```astro
---
import Toc from "../components/Toc.astro";
---

<div class="container page-body">
  <Toc
    items={[
      { href: "#steps", label: "What happens on each store" },
      { href: "#permissions", label: "The two permissions it asks for" },
    ]}
  />
  <article class="prose">
    <h2 id="steps">What happens on each store</h2>
    <p>…</p>
    <h2 id="permissions">The two permissions it asks for</h2>
    <p>…</p>
  </article>
</div>
```

### `StoreButton` (`src/components/StoreButton.astro`)

No props. While `chromeWebStoreUrl` in `site.config.json` is empty (or not an https URL), it renders an inactive, non-link element reading "Coming soon to the Chrome Web Store". Once the URL is set, it renders an "Add to Chrome" link to it. Never hand-write a store link.

```astro
<StoreButton />
```

### `Callout` (`src/components/Callout.astro`)

A highlighted note with `role="note"`.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tone` | `"note"` or `"caution"` | `"note"` | `caution` uses the warning brown, for side effects such as the delivery location change. |
| `title` | string | none | A short bold first line. |

```astro
<Callout tone="caution" title="Each store's delivery location may change">
  <p>Before reading a store, the extension may set its "Deliver to" country to yours and leave it that way.</p>
</Callout>
```

### `TableScroll` (`src/components/TableScroll.astro`)

Wraps a hand-written table so it scrolls sideways on phones instead of widening the page. It is keyboard focusable and named for screen readers.

| Prop | Type | Default | Meaning |
| --- | --- | --- | --- |
| `label` | string | required | What the table lists, for example "Stored data". |

```astro
<TableScroll label="Stored data">
  <table>
    <thead><tr><th>What</th><th>How long</th></tr></thead>
    <tbody><tr><td>Your settings</td><td>Until you change them</td></tr></tbody>
  </table>
</TableScroll>
```

Code inside a table cell never wraps, and from 560px a row header (`<th scope="row">`) is as wide as its content and does not wrap. Below 560px cells get tighter padding and row headers wrap. Put a long list in a cell one item per line (a `ul` inside the cell, or one row per item), never as a comma-separated run.

Put `class="table-stack"` on two-column description tables, where each row is a row header (`<th scope="row">`) and its explanation. Below 560px the table stacks: the column headers are hidden, each row header sits full width above its cell, and a hairline separates the rows. Leave short lookup tables with several columns, such as the stores table, unstacked.

```astro
<TableScroll label="Permissions">
  <table class="table-stack">
    <thead><tr><th scope="col">Permission</th><th scope="col">Why it is needed</th></tr></thead>
    <tbody><tr><th scope="row"><code>storage</code></th><td>Keeps your settings and past results.</td></tr></tbody>
  </table>
</TableScroll>
```

Tables in Markdown content are wrapped the same way automatically by `src/lib/markdown-pipeline.mjs`, as a region named after the table's header cells (for example "What, How long"). The same file keeps bare host names in Markdown, such as `www.example.org`, as plain text instead of turning them into links; write `[text](https://…)` for a link. It also removes a Markdown document's leading `h1` from the rendered body and passes its text on as `remarkPluginFrontmatter.title` from `render()`, so a page can show it through `PageIntro`, as `privacy.astro` does.

### Used by the layout

`Header`, `Footer`, `ThemeToggle` and `Logo` are already in `Base`; pages do not use them directly. The header and footer links come from `navigation` in `src/site.config.ts`. The header marks the current page with `aria-current="page"`. On phones the links move into a "Menu" disclosure.

## Data and configuration

From `src/site.config.ts`:

| Export | Meaning |
| --- | --- |
| `supportIssuesUrl` | GitHub Issues, for support requests. |
| `supportEmail` | The support email address, for support requests by email. Link it with `mailto:`. |
| `securityReportUrl` | GitHub private vulnerability reporting, for security reports. |
| `repositoryUrl` | The GitHub repository. |
| `chromeWebStoreUrl`, `isStoreLive` | The store listing URL and whether it is set. Prefer `StoreButton`. |
| `navigation` | The header and footer links. |
| `siteName`, `siteUrl`, `siteDescription` | Site-wide strings. |

From `src/data/stores.ts`: `stores`, the ten supported stores in the extension's order, each with `code`, `country`, `domain` and `currency`.

```astro
---
import { supportIssuesUrl } from "../site.config";
import { stores } from "../data/stores";
---

<p><a href={supportIssuesUrl}>Open an issue on GitHub</a></p>
<ul>{stores.map((store) => <li>{store.country}: {store.domain}</li>)}</ul>
```

## CSS classes (`src/styles/global.css`)

| Class | Use |
| --- | --- |
| `container` | Centres content at 1120px wide with the side gutter (16px on phones). Wrap every page section in it. |
| `page-body` | Bottom padding for the content under a `PageIntro`. With a `Toc` inside, it becomes two columns from 1080px. |
| `prose` | Long-form text: headings, paragraphs, lists, tables, code, blockquotes. Caps the line length at 68 characters. |
| `section` | Vertical padding for a homepage-style section. |
| `section-band` | A tinted full-width band with hairlines above and below. Combine with `section`. |
| `section-title` | Large `h2` for sections outside `prose`. |
| `page-title` | The `h1` size; `PageIntro` already applies it. |
| `lede` | Larger muted intro paragraph. |
| `muted`, `small`, `numeric` | Muted colour, 14px text, tabular figures. |
| `nowrap` | Keeps a quoted interface label on one line: `<span class="nowrap">“Check 9 other Amazons”</span>`. Include the quote marks in the span. |
| `button` with `button-primary` or `button-secondary` | Links styled as buttons, 48px tall. Below 560px every button is full width. |
| `card` | A bordered, lightly tinted panel. |
| `callout`, `callout-caution` | What `Callout` renders. |
| `table-scroll` | What `TableScroll` renders. |
| `table-stack` | On a `table`: stacks each row below 560px. Put it on two-column description tables. |
| `visually-hidden` | Text for screen readers only. |

Colours come from tokens such as `var(--color-ink)`, `var(--color-muted)`, `var(--color-link)`, `var(--color-highlight)`, `var(--color-hairline)`, `var(--color-rule-strong)` and `var(--color-band)`. Effects have tokens too: `--color-frame-bg` (screenshot frame), `--shadow-frame`, `--shadow-menu`, `--ring-on-dark` (a hairline ring for dark tiles, `none` in light) and `--glow-orange` (a filter, `none` in light). They switch between the light and dark theme on their own, so never hard-code a colour.

## Rules for every page

- No code comments, no third-party requests, fonts or scripts, no inline styles that hard-code colours.
- Internal links end with a slash: `/faq/`, not `/faq`.
- The example destination country is always Switzerland (CH, CHF).
- No personal names, and no email address except `supportEmail` from the config. The developer is "the developer". Support goes to GitHub Issues or `supportEmail`, security reports to private vulnerability reporting.
- Copy is plain, second person and short, with British/International spelling. No exclamation marks and no em dashes.
