import i18n from "@/i18n";

/** What's wrong with an account or bucket name, if anything: 1 to 100 characters after trimming. */
export function checkName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return i18n.t("common.enterName");
  if (trimmed.length > 100) return i18n.t("common.maxChars", { count: 100 });
  return undefined;
}
