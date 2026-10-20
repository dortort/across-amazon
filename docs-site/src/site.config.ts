import rawConfig from "../site.config.json";

export interface SiteConfig {
  chromeWebStoreUrl: string;
  supportIssuesUrl: string;
  securityReportUrl: string;
  repositoryUrl: string;
}

export interface NavigationItem {
  href: string;
  label: string;
}

export const siteConfig: SiteConfig = rawConfig;

export const { chromeWebStoreUrl, supportIssuesUrl, securityReportUrl, repositoryUrl } = siteConfig;

const isHttpsUrl = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  return new URL(value).protocol === "https:";
};

export const isStoreLive: boolean = isHttpsUrl(chromeWebStoreUrl.trim());

export const siteName = "Across Amazon";

export const siteUrl = "https://across-amazon.dortort.dev";

export const siteDescription =
  "Across Amazon is a Chrome extension that shows which Amazon store delivers the product you are viewing for less: item, shipping and import fees, in one currency.";

export const navigation: readonly NavigationItem[] = [
  { href: "/how-it-works/", label: "How it works" },
  { href: "/faq/", label: "FAQ" },
  { href: "/support/", label: "Support" },
  { href: "/privacy/", label: "Privacy" },
  { href: "/changelog/", label: "Changelog" },
];
