export interface RobotCheckMarkers {
  pathPrefixes: string[];
  formAction: string;
}

export interface PageInspection {
  url: string;
  robotCheck: boolean;
}

export const ROBOT_CHECK_MARKERS: RobotCheckMarkers = {
  pathPrefixes: ["/errors/validateCaptcha", "/errors_page/validateCaptcha", "/checkpoint/"],
  formAction: "validateCaptcha"
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

export function isRobotCheck(url: string, html = "", markers: RobotCheckMarkers = ROBOT_CHECK_MARKERS): boolean {
  return hasPathPrefix(url, markers) || hasCaptchaForm(html, markers);
}

// chrome.scripting.executeScript runs this in the page from its source, so it must not use anything outside its body.
export function inspectPage(markers: RobotCheckMarkers): PageInspection {
  const robotCheck =
    markers.pathPrefixes.some((prefix) => location.pathname.startsWith(prefix)) ||
    document.querySelector(`form[action*="${markers.formAction}"]`) !== null;
  return { url: location.href, robotCheck };
}
