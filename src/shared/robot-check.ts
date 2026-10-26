export interface RobotCheckMarkers {
  pathPrefixes: string[];
  formAction: string;
  status: number;
}

export interface PageInspection {
  url: string;
  robotCheck: boolean;
}

export const ROBOT_CHECK_MARKERS: RobotCheckMarkers = {
  pathPrefixes: ["/errors/validateCaptcha", "/errors_page/validateCaptcha", "/checkpoint/"],
  formAction: "validateCaptcha",
  status: 503
};

export const ROBOT_CHECK_NOTE_PREFIX = "Amazon showed a robot check on ";

export function robotCheckNote(domain: string): string {
  return `${ROBOT_CHECK_NOTE_PREFIX}${domain}`;
}

function hasPathPrefix(url: string, markers: RobotCheckMarkers): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return markers.pathPrefixes.some((prefix) => pathname.startsWith(prefix));
}

function hasCaptchaForm(html: string, markers: RobotCheckMarkers): boolean {
  const forms = html.match(/<form\b[^>]*>/gi) ?? [];
  return forms.some((tag) => /\baction\s*=\s*["']?([^"'\s>]*)/i.exec(tag)?.[1]?.includes(markers.formAction) === true);
}

export function isRobotCheck(
  url: string,
  html = "",
  status?: number,
  markers: RobotCheckMarkers = ROBOT_CHECK_MARKERS
): boolean {
  return status === markers.status || hasPathPrefix(url, markers) || hasCaptchaForm(html, markers);
}

// chrome.scripting.executeScript runs this in the page from its source, so it must not use anything outside its body.
export function inspectPage(markers: RobotCheckMarkers): PageInspection {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const robotCheck =
    navigation?.responseStatus === markers.status ||
    markers.pathPrefixes.some((prefix) => location.pathname.startsWith(prefix)) ||
    document.querySelector(`form[action*="${markers.formAction}"]`) !== null;
  return { url: location.href, robotCheck };
}
