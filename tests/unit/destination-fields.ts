export interface DestinationFields {
  vas?: string;
  input?: string;
  nav?: string | null;
}

export function destinationFields({ vas, input, nav }: DestinationFields): string {
  return [
    vas === undefined ? "" : `<script type="a-state" data-a-state='{"key":"vas-base-vm"}'>{"countryCode":"${vas}","zipCode":null}</script>`,
    input === undefined ? "" : `<input type="hidden" id="countryCode" value="${input}">`,
    nav === undefined ? "" : `<script>$Nav.declare('config.customerCountryCode',${nav === null ? "null" : `'${nav}'`});</script>`
  ].join("");
}
