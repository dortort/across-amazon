# Across Amazon website

The public website for the Across Amazon Chrome extension: homepage, how it works, FAQ, support, privacy policy and changelog. It gives the Chrome Web Store listing its privacy policy and support URLs.

Live at <https://across-amazon.dortort.dev>.

It is a static [Astro](https://astro.build) site with no cookies, no analytics and no third-party requests. It has its own `package.json` and lockfile, separate from the extension's.

## Run it locally

Run these from this `docs-site/` folder. The site needs Node 22.22 or newer and the pnpm version pinned in `package.json` (`packageManager`).

| Command | What it does |
| --- | --- |
| `pnpm install` | Installs the site's dependencies. |
| `pnpm dev` | Starts a dev server at <http://localhost:4321>. |
| `pnpm build` | Builds the static site into `dist/`. |
| `pnpm preview` | Serves the built `dist/` locally. |
| `pnpm check` | Runs `astro check` for type and template errors. |
| `pnpm check:links` | Checks every internal link, asset and `#anchor` in `dist/`. Run it after a build. Add `--external` to also fetch external links, or `--require /path/` to assert that a page exists. |

## Configuration

`site.config.json` holds the values that change outside the code:

- `chromeWebStoreUrl` is the Chrome Web Store listing. Every store link on the site, including the "Add to Chrome" buttons, points to it. If it is empty or not an https URL, every "Add to Chrome" button renders as an inactive "Coming soon to the Chrome Web Store" instead, and the support page says the listing is not published yet.
- `supportIssuesUrl` is where the support page sends people for help (GitHub Issues).
- `supportEmail` is the address the support page gives, as a `mailto:` link, for help by email instead of GitHub.
- `securityReportUrl` is where security reports go (GitHub private vulnerability reporting).
- `repositoryUrl` is the source repository linked from the footer.

## Privacy policy

`/privacy/` is generated at build time from `docs/privacy-policy.md` at the repository root. Edit that file, not the page. A change to it rebuilds and redeploys the site.

## Deployment

The "Docs site" workflow in `.github/workflows/docs-site.yml` runs on pull requests and pushes to `main` that touch `docs-site/`, `docs/privacy-policy.md` or the workflow itself. It can also be started by hand. It installs, runs `pnpm check`, builds, and checks links, failing if `/privacy/`, `/support/`, `/how-it-works/` or `/faq/` is missing. On pushes to `main` and manual runs it then deploys `dist/` to GitHub Pages.

One-time setup:

1. In the repository's Pages settings, set the source to "GitHub Actions" and the custom domain to `across-amazon.dortort.dev`. Turn on "Enforce HTTPS" once GitHub has issued the certificate.
2. `public/CNAME` holds the same domain and Astro copies it into `dist/`. GitHub ignores that file for Actions deployments, so the Pages setting in step 1 is what serves the domain.
3. At the DNS provider for `dortort.dev`, add this record, set to DNS only (not proxied) so GitHub can issue the certificate:

   | Type | Name | Target |
   | --- | --- | --- |
   | CNAME | `across-amazon` | `dortort.github.io` |

4. Verify `dortort.dev` in the GitHub account's Pages settings so no other account can claim the subdomain.
