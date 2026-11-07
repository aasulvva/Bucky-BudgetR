import { Button, Checkbox, Group, Select, Stack } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useAccounts, useBuckets, type Account, type Bucket } from "@/api/accounts";
import { ErrorAlert } from "@/components/ErrorAlert";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import {
  ACCOUNTS_MODES,
  BUCKET_STATUS_MODES,
  TRANSACTION_COUNTS,
  settingsComplete,
  type AccountsSettings,
  type BucketStatusSettings,
  type WidgetInstance,
  type SaveWidget,
} from "@/lib/dashboard";

/**
 * A widget's settings, for its cog and for adding a widget. Saving hands the
 * changed widget to `onSave`, which saves it, or adds it to the layout being
 * edited.
 */
export function WidgetSettingsDialog({
  widget,
  opened,
  title,
  saveLabel,
  onClose,
  onSave,
}: {
  widget: WidgetInstance;
  opened: boolean;
  title: string;
  saveLabel?: string;
  onClose: () => void;
  onSave: SaveWidget;
}) {
  return (
    <ResponsiveModal opened={opened} onClose={onClose} title={title}>
      {opened && (
        <WidgetSettingsForm
          widget={widget}
          saveLabel={saveLabel}
          onClose={onClose}
          onSave={onSave}
        />
      )}
    </ResponsiveModal>
  );
}

/** A widget's settings, with Cancel and Save (or `saveLabel`). */
export function WidgetSettingsForm({
  widget,
  saveLabel,
  onClose,
  onSave,
}: {
  widget: WidgetInstance;
  saveLabel?: string;
  onClose: () => void;
  onSave: SaveWidget;
}) {
  const { t } = useTranslation();
  const accounts = useAccounts().data ?? [];
  const buckets = useBuckets().data ?? [];
  const [draft, setDraft] = useState(widget);
  const save = useMutation({
    mutationFn: async (w: WidgetInstance) => {
      await onSave(w);
    },
    meta: { silentError: true },
    onSuccess: onClose,
  });

  return (
    <Stack gap="md">
      {draft.type === "cycle" && (
        <Checkbox
          label={t("dashboard.cycle.showNext")}
          checked={draft.settings.showNext}
          onChange={(e) => {
            setDraft({ ...draft, settings: { showNext: e.currentTarget.checked } });
          }}
        />
      )}
      {draft.type === "bucket_status" && (
        <BucketStatusForm
          value={draft.settings}
          onChange={(settings) => {
            setDraft({ ...draft, settings });
          }}
          accounts={accounts}
          buckets={buckets}
        />
      )}
      {draft.type === "accounts" && (
        <AccountsForm
          value={draft.settings}
          onChange={(settings) => {
            setDraft({ ...draft, settings });
          }}
          accounts={accounts}
        />
      )}
      {draft.type === "recent_transactions" && (
        <Select
          label={t("dashboard.recent.count")}
          data={TRANSACTION_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
          value={String(draft.settings.count)}
          allowDeselect={false}
          onChange={(v) => {
            if (v) setDraft({ ...draft, settings: { count: Number(v) } });
          }}
        />
      )}
      {save.error && <ErrorAlert error={save.error} />}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          loading={save.isPending}
          disabled={!settingsComplete(draft, accounts, buckets)}
          onClick={() => {
            save.mutate(draft);
          }}
        >
          {saveLabel ?? t("common.save")}
        </Button>
      </Group>
    </Stack>
  );
}

function BucketStatusForm({
  value,
  onChange,
  accounts,
  buckets,
}: {
  value: BucketStatusSettings;
  onChange: (value: BucketStatusSettings) => void;
  accounts: Account[];
  buckets: Bucket[];
}) {
  const { t } = useTranslation();
  const groups = accounts
    .map((a) => ({
      group: a.name,
      items: buckets
        .filter((b) => b.source_account_id === a.id)
        .map((b) => ({ value: b.id, label: b.name })),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <>
      <Select
        label={t("dashboard.bucketStatus.show")}
        data={BUCKET_STATUS_MODES.map((m) => ({
          value: m,
          label: t(`dashboard.bucketStatus.modes.${m}`),
        }))}
        value={value.mode}
        allowDeselect={false}
        onChange={(v) => {
          const mode = BUCKET_STATUS_MODES.find((m) => m === v);
          if (mode) onChange({ ...value, mode });
        }}
      />
      {value.mode === "bucket" && (
        <Select
          label={t("dashboard.bucketStatus.bucket")}
          placeholder={t("dashboard.bucketStatus.pickBucket")}
          data={groups}
          value={buckets.some((b) => b.id === value.bucketId) ? value.bucketId : null}
          onChange={(bucketId) => {
            onChange({ ...value, bucketId });
          }}
          searchable
        />
      )}
    </>
  );
}

function AccountsForm({
  value,
  onChange,
  accounts,
}: {
  value: AccountsSettings;
  onChange: (value: AccountsSettings) => void;
  accounts: Account[];
}) {
  const { t } = useTranslation();
  return (
    <>
      <Select
        label={t("dashboard.accounts.show")}
        data={ACCOUNTS_MODES.map((m) => ({ value: m, label: t(`dashboard.accounts.modes.${m}`) }))}
        value={value.mode}
        allowDeselect={false}
        onChange={(v) => {
          const mode = ACCOUNTS_MODES.find((m) => m === v);
          if (mode) onChange({ ...value, mode });
        }}
      />
      {value.mode === "account" && (
        <Select
          label={t("dashboard.accounts.account")}
          placeholder={t("dashboard.accounts.pickAccount")}
          data={accounts.map((a) => ({ value: a.id, label: a.name }))}
          value={accounts.some((a) => a.id === value.accountId) ? value.accountId : null}
          onChange={(accountId) => {
            onChange({ ...value, accountId });
          }}
          searchable
        />
      )}
    </>
  );
}
