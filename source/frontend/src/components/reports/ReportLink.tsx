import { Anchor, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { usePrintMode } from "@/lib/print";

/** A module's link to its transactions; plain text in a PDF (#127). */
export function ReportLink({ to, children }: { to: string; children: ReactNode }) {
  if (usePrintMode()) {
    return (
      <Text span size="sm">
        {children}
      </Text>
    );
  }
  return (
    <Anchor component={Link} to={to} size="sm">
      {children}
    </Anchor>
  );
}
