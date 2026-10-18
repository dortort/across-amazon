import type { ReactElement } from "react";
import type { FxTable } from "../../shared/types";

interface FooterProps {
  fxTable?: FxTable;
}

export function Footer({ fxTable }: FooterProps): ReactElement {
  return (
    <div className="dB-foot">
      <span>Not affiliated with Amazon</span>
      <span>{fxTable ? `Rates ${fxTable.date}` : "ECB daily rates"}</span>
    </div>
  );
}
