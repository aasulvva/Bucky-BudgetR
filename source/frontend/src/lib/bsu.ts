// BSU accounts (#214, spec §2.1).

import { ApiError } from "@/api/errors";

/** What the server asks to confirm before recording a transaction. */
export type BsuAsk = "bsu_over_limit" | "bsu_withdrawal";

/** What the server asks to confirm, if error is a BSU 409. */
export function bsuAsk(error: unknown): BsuAsk | undefined {
  if (!(error instanceof ApiError)) return undefined;
  return error.code === "bsu_over_limit" || error.code === "bsu_withdrawal"
    ? error.code
    : undefined;
}
