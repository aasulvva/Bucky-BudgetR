import { MultiSelect, Stack, TextInput } from "@mantine/core";
import { useDebouncedCallback } from "@mantine/hooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";

/** The filters a graph or report has (#122, #125). */
export interface Filters {
  account_ids?: string[];
  bucket_ids?: string[];
  tags?: string[];
  counterparty?: string;
}

interface FilterFieldsProps {
  value: Filters;
  onChange: (patch: Filters) => void;
  accounts: Account[];
  buckets: Bucket[];
  tags: string[];
  /** Balances have only accounts. */
  accountsOnly?: boolean;
  /** Dropdowns in place, not in a portal (inside a drawer or dialog). */
  inline?: boolean;
  /** An empty field uses the report's (a report module, #125). */
  inherits?: boolean;
}

/** Accounts, buckets, tags and counterparty: what a graph or report counts. */
export function FilterFields({
  value,
  onChange,
  accounts,
  buckets,
  tags,
  accountsOnly = false,
  inline = false,
  inherits = false,
}: FilterFieldsProps) {
  const { t } = useTranslation();
  const dropdown = inline ? { withinPortal: false } : undefined;
  const [counterparty, setCounterparty] = useState(value.counterparty ?? "");
  // Follow a counterparty set from elsewhere (a saved graph, Back).
  const [shown, setShown] = useState(value.counterparty ?? "");
  if ((value.counterparty ?? "") !== shown) {
    setShown(value.counterparty ?? "");
    if (counterparty.trim() !== (value.counterparty ?? "")) {
      setCounterparty(value.counterparty ?? "");
    }
  }
  const setCounterpartyLater = useDebouncedCallback((q: string) => {
    onChange({ counterparty: q });
  }, 400);
  const empty = (fallback: string) => (inherits ? t("stats.reports.asReport") : fallback);
  const chosenAccounts = value.account_ids ?? [];
  // Buckets of the chosen accounts, when any are chosen.
  const bucketOptions = buckets
    .filter((b) => chosenAccounts.length === 0 || chosenAccounts.includes(b.source_account_id))
    .map((b) => ({ value: b.id, label: b.name }));

  return (
    <Stack gap="sm">
      <MultiSelect
        comboboxProps={dropdown}
        label={t("stats.graphs.accounts")}
        placeholder={chosenAccounts.length === 0 ? empty(t("stats.graphs.allAccounts")) : undefined}
        description={!accountsOnly ? t("stats.graphs.accountsHint") : undefined}
        data={accounts.map((a) => ({ value: a.id, label: a.name }))}
        value={chosenAccounts}
        onChange={(ids) => {
          onChange({ account_ids: ids });
        }}
        searchable
        clearable
      />
      {!accountsOnly && (
        <>
          <MultiSelect
            comboboxProps={dropdown}
            label={t("stats.graphs.buckets")}
            placeholder={
              (value.bucket_ids ?? []).length === 0
                ? empty(t("stats.graphs.allBuckets"))
                : undefined
            }
            data={bucketOptions}
            value={value.bucket_ids ?? []}
            onChange={(ids) => {
              onChange({ bucket_ids: ids });
            }}
            searchable
            clearable
          />
          <MultiSelect
            comboboxProps={dropdown}
            label={t("stats.graphs.tags")}
            placeholder={
              (value.tags ?? []).length === 0 ? empty(t("stats.graphs.anyTag")) : undefined
            }
            data={[...new Set([...tags, ...(value.tags ?? [])])]}
            value={value.tags ?? []}
            onChange={(chosen) => {
              onChange({ tags: chosen });
            }}
            searchable
            clearable
          />
          <TextInput
            label={t("stats.graphs.counterparty")}
            placeholder={inherits ? t("stats.reports.asReport") : undefined}
            value={counterparty}
            onChange={(e) => {
              setCounterparty(e.currentTarget.value);
              setCounterpartyLater(e.currentTarget.value);
            }}
          />
        </>
      )}
    </Stack>
  );
}
