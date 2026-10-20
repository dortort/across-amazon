import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SITE_ORIGIN = "https://across-amazon.dortort.dev";
const IGNORED_SCHEMES = new Set(["mailto", "tel", "javascript", "data", "about"]);
const WEB_SCHEMES = new Set(["http", "https"]);
const EXTERNAL_TIMEOUT_MS = 15_000;
const EXTERNAL_CONCURRENCY = 8;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const USAGE = "Usage: node scripts/check-links.mjs <distDir> [--external] [--require <path>]...";

const TAG_PATTERN = /<[a-zA-Z][\w:-]*(?:"[^"]*"|'[^']*'|[^"'>])*>/g;
const TAG_NAME_PATTERN = /^<([a-zA-Z][\w:-]*)/;
const ATTRIBUTE_PATTERN = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const RAW_TEXT_OPENING_PATTERN = /<(script|style)(?=[\s/>])[^>]*>/gi;
const SRCSET_CANDIDATE_PATTERN = /[\s,]*(\S*[^\s,])(?:,+(?=\s|$)|\s+[^,]*)?/g;
const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "]
]);

class UsageError extends Error {}

function parseArguments(argv) {
  const options = { distDir: undefined, checkExternal: false, requiredPaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (argument === "--external") {
      options.checkExternal = true;
    } else if (argument === "--require") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw new UsageError("--require needs a site path such as /privacy/");
      options.requiredPaths.push(value);
      index += 1;
    } else if (argument.startsWith("--require=")) {
      options.requiredPaths.push(argument.slice("--require=".length));
    } else if (argument.startsWith("-")) {
      throw new UsageError(`Unknown option ${argument}`);
    } else if (options.distDir === undefined) {
      options.distDir = argument;
    } else {
      throw new UsageError(`Unexpected argument ${argument}`);
    }
  }
  if (options.distDir === undefined) throw new UsageError("Missing <distDir>");
  const relativeRequirement = options.requiredPaths.find((requiredPath) => !requiredPath.startsWith("/"));
  if (relativeRequirement !== undefined) throw new UsageError(`--require path must start with /: ${relativeRequirement}`);
  return options;
}

async function isDirectory(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function createFileExistenceCache() {
  const known = new Map();
  return async function isFile(candidate) {
    if (!known.has(candidate)) {
      known.set(
        candidate,
        stat(candidate).then(
          (stats) => stats.isFile(),
          () => false
        )
      );
    }
    return known.get(candidate);
  };
}

async function listHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".html"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function toSitePath(distDir, file) {
  return path.relative(distDir, file).split(path.sep).join("/");
}

function toPageUrl(distDir, htmlFile) {
  const encodedPath = toSitePath(distDir, htmlFile).split("/").map(encodeURIComponent).join("/");
  return new URL(encodedPath, `${SITE_ORIGIN}/`);
}

function decodeHtmlEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, body) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? entity;
  });
}

function findRawTextOpening(html, fromIndex) {
  RAW_TEXT_OPENING_PATTERN.lastIndex = fromIndex;
  return RAW_TEXT_OPENING_PATTERN.exec(html);
}

function removeCommentsAndRawText(html) {
  let output = "";
  let index = 0;
  while (index < html.length) {
    const commentStart = html.indexOf("<!--", index);
    const rawTextOpening = findRawTextOpening(html, index);
    const rawTextStart = rawTextOpening === null ? -1 : rawTextOpening.index;
    if (commentStart === -1 && rawTextStart === -1) {
      output += html.slice(index);
      break;
    }
    if (rawTextStart === -1 || (commentStart !== -1 && commentStart < rawTextStart)) {
      output += html.slice(index, commentStart);
      const commentEnd = html.indexOf("-->", commentStart + "<!--".length);
      index = commentEnd === -1 ? html.length : commentEnd + "-->".length;
      continue;
    }
    const bodyStart = rawTextStart + rawTextOpening[0].length;
    const closing = new RegExp(`</${rawTextOpening[1]}\\s*>`, "i").exec(html.slice(bodyStart));
    output += html.slice(index, bodyStart);
    if (closing === null) break;
    output += closing[0];
    index = bodyStart + closing.index + closing[0].length;
  }
  return output;
}

function readTags(html) {
  return Array.from(removeCommentsAndRawText(html).matchAll(TAG_PATTERN), ([tag]) => {
    const [opening, tagName] = TAG_NAME_PATTERN.exec(tag);
    const attributes = Array.from(tag.slice(opening.length).matchAll(ATTRIBUTE_PATTERN), (match) => {
      const rawValue = match[2] ?? match[3] ?? match[4];
      return { name: match[1].toLowerCase(), value: rawValue === undefined ? undefined : decodeHtmlEntities(rawValue) };
    });
    return { name: tagName.toLowerCase(), attributes };
  });
}

function parseSrcset(value) {
  return Array.from(value.matchAll(SRCSET_CANDIDATE_PATTERN), ([, candidateUrl]) => candidateUrl);
}

function extractLinkReferences(tags) {
  const references = [];
  for (const { attributes } of tags) {
    for (const { name, value } of attributes) {
      if (value === undefined) continue;
      if (name === "href" || name === "src") references.push(value.trim());
      else if (name === "srcset") references.push(...parseSrcset(value));
    }
  }
  return references;
}

function collectFragmentTargets(tags) {
  const targets = new Set();
  for (const { name: tagName, attributes } of tags) {
    for (const { name, value } of attributes) {
      if (!value) continue;
      if (name === "id" || (name === "name" && tagName === "a")) targets.add(value);
    }
  }
  return targets;
}

function classifyReference(reference, pageUrl) {
  if (reference === "") return { kind: "ignored" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(reference)?.[1].toLowerCase();
  if (scheme !== undefined && IGNORED_SCHEMES.has(scheme)) return { kind: "ignored" };
  if (scheme !== undefined && !WEB_SCHEMES.has(scheme)) return { kind: "invalid", reason: `unsupported URL scheme "${scheme}:"` };
  let url;
  try {
    url = new URL(reference, pageUrl);
  } catch {
    return { kind: "invalid", reason: "malformed URL" };
  }
  if (url.origin === SITE_ORIGIN) return { kind: "internal", url };
  return { kind: "external", url };
}

function decodePathOrFragment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

async function findTargetFile(distDir, pathname, isFile) {
  const decodedPath = decodePathOrFragment(pathname);
  if (decodedPath === undefined) return undefined;
  const basePath = path.join(distDir, decodedPath);
  if (basePath !== distDir && !basePath.startsWith(`${distDir}${path.sep}`)) return undefined;
  const candidates = decodedPath.endsWith("/")
    ? [path.join(basePath, "index.html")]
    : [basePath, path.join(basePath, "index.html"), `${basePath}.html`];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

function isTopOfPageFragment(fragment) {
  return fragment.toLowerCase() === "top";
}

async function checkInternalLink({ url, distDir, isFile, fragmentTargetsOf }) {
  const targetFile = await findTargetFile(distDir, url.pathname, isFile);
  if (targetFile === undefined) return `no page or file at ${url.pathname}`;
  if (url.hash.length <= 1 || !targetFile.toLowerCase().endsWith(".html")) return undefined;
  const rawFragment = url.hash.slice(1);
  const fragment = decodePathOrFragment(rawFragment) ?? rawFragment;
  if (isTopOfPageFragment(fragment)) return undefined;
  const targets = await fragmentTargetsOf(targetFile);
  if (targets.has(rawFragment) || targets.has(fragment)) return undefined;
  return `no element with id "${fragment}" in ${toSitePath(distDir, targetFile)}`;
}

function createFragmentTargetReader() {
  const known = new Map();
  return function fragmentTargetsOf(htmlFile) {
    if (!known.has(htmlFile)) {
      known.set(
        htmlFile,
        readFile(htmlFile, "utf8").then((html) => collectFragmentTargets(readTags(html)))
      );
    }
    return known.get(htmlFile);
  };
}

async function requestStatus(url, method) {
  const response = await fetch(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
    headers: {
      "user-agent": BROWSER_USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  await response.body?.cancel();
  return response.status;
}

function describeRequestError(error) {
  if (error?.name === "TimeoutError") return `timed out after ${EXTERNAL_TIMEOUT_MS / 1000} s`;
  const cause = error?.cause;
  return cause?.code ?? cause?.message ?? error?.message ?? String(error);
}

async function checkExternalUrl(url) {
  try {
    let status = await requestStatus(url, "HEAD");
    if (status >= 400) status = await requestStatus(url, "GET");
    if (status >= 200 && status < 400) return undefined;
    return `HTTP ${status}`;
  } catch (error) {
    return `request failed: ${describeRequestError(error)}`;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function drainQueue() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drainQueue));
  return results;
}

function stripFragment(url) {
  const withoutFragment = new URL(url);
  withoutFragment.hash = "";
  return withoutFragment.href;
}

async function checkSite({ distDir, checkExternal, requiredPaths }) {
  const isFile = createFileExistenceCache();
  const fragmentTargetsOf = createFragmentTargetReader();
  const htmlFiles = await listHtmlFiles(distDir);
  const failures = [];
  const externalSources = new Map();
  const counts = { htmlFiles: htmlFiles.length, internal: 0, externalOccurrences: 0, ignored: 0 };

  if (htmlFiles.length === 0) failures.push({ source: ".", reference: "", reason: "no HTML files found; build the site first" });

  for (const htmlFile of htmlFiles) {
    const source = toSitePath(distDir, htmlFile);
    const pageUrl = toPageUrl(distDir, htmlFile);
    const references = extractLinkReferences(readTags(await readFile(htmlFile, "utf8")));
    for (const reference of references) {
      const classification = classifyReference(reference, pageUrl);
      if (classification.kind === "ignored") {
        counts.ignored += 1;
      } else if (classification.kind === "invalid") {
        failures.push({ source, reference, reason: classification.reason });
      } else if (classification.kind === "external") {
        counts.externalOccurrences += 1;
        const target = stripFragment(classification.url);
        if (!externalSources.has(target)) externalSources.set(target, new Set());
        externalSources.get(target).add(source);
      } else {
        counts.internal += 1;
        const reason = await checkInternalLink({ url: classification.url, distDir, isFile, fragmentTargetsOf });
        if (reason !== undefined) failures.push({ source, reference, reason });
      }
    }
  }

  if (checkExternal) {
    const externalUrls = [...externalSources.keys()];
    const reasons = await mapWithConcurrency(externalUrls, EXTERNAL_CONCURRENCY, checkExternalUrl);
    externalUrls.forEach((externalUrl, index) => {
      if (reasons[index] === undefined) return;
      for (const source of externalSources.get(externalUrl)) failures.push({ source, reference: externalUrl, reason: reasons[index] });
    });
  }

  const missingRequiredPaths = [];
  for (const requiredPath of requiredPaths) {
    const targetFile = await findTargetFile(distDir, new URL(requiredPath, SITE_ORIGIN).pathname, isFile);
    if (targetFile === undefined) {
      missingRequiredPaths.push(requiredPath);
      failures.push({ source: "--require", reference: requiredPath, reason: "required page is missing" });
    }
  }

  return { counts, externalUniqueCount: externalSources.size, missingRequiredPaths, failures };
}

function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function compareFailures(left, right) {
  return left.source.localeCompare(right.source) || left.reference.localeCompare(right.reference);
}

function printReport({ distLabel, checkExternal, requiredPaths, result }) {
  const { counts, externalUniqueCount, missingRequiredPaths, failures } = result;
  if (failures.length > 0) {
    console.log("Broken links:");
    for (const failure of [...failures].sort(compareFailures)) {
      console.log(`  ${failure.source}: ${failure.reference || "(none)"}  ${failure.reason}`);
    }
    console.log("");
  }
  const externalSummary = checkExternal
    ? `${externalUniqueCount} unique checked (${pluralize(counts.externalOccurrences, "reference", "references")})`
    : `${externalUniqueCount} unique skipped (${pluralize(counts.externalOccurrences, "reference", "references")}); pass --external to check them`;
  const requiredSummary =
    requiredPaths.length === 0
      ? "none"
      : `${requiredPaths.length - missingRequiredPaths.length} of ${requiredPaths.length} present`;
  console.log(`Link check of ${distLabel}`);
  console.log(`  HTML files scanned:      ${counts.htmlFiles}`);
  console.log(`  Internal links checked:  ${counts.internal}`);
  console.log(`  External links:          ${externalSummary}`);
  console.log(`  Skipped non-web links:   ${counts.ignored}`);
  console.log(`  Required pages:          ${requiredSummary}`);
  console.log(`  Failures:                ${failures.length}`);
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n${USAGE}`);
    process.exit(2);
  }
  const distDir = path.resolve(options.distDir);
  if (!(await isDirectory(distDir))) {
    console.error(`Not a directory: ${options.distDir}. Build the site first.`);
    process.exit(1);
  }
  const result = await checkSite({ ...options, distDir });
  printReport({ distLabel: options.distDir, checkExternal: options.checkExternal, requiredPaths: options.requiredPaths, result });
  process.exitCode = result.failures.length > 0 ? 1 : 0;
}

await main();
