import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Card,
  Group,
  NavLink,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconPlus, IconSettings } from "@tabler/icons-react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";

import {
  refillModeLabel,
  useAccounts,
  useBuckets,
  type Account,
  type Bucket,
} from "@/api/accounts";
import { BucketSettingsDrawer } from "@/components/BucketSettings";
import { BucketForm, FormTitle } from "@/components/buckets/BucketForm";
import { QueryState } from "@/components/QueryState";
import { ResponsiveModal } from "@/components/ResponsiveModal";
import { formatMoney } from "@/lib/money";

/** The selected bucket in the URL: a bucket ID (`?edit=<id>`), "new" (`?new`), or null. */
type Selection = string | null;

/**
 * Bucket setup (spec §9, canvas "Bucket setup"): the buckets by source
 * account, and the selected one's form beside them (full screen on mobile).
 * `?edit=<id>` opens a bucket, as the cog on the Buckets screen does, and
 * `?settings` the bucket settings (#102), over the form if one is open.
 */
export default function BucketSetup() {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const accounts = useAccounts();
  const buckets = useBuckets();
  const [params, setParams] = useSearchParams();
  const selection: Selection = params.has("new") ? "new" : params.get("edit");
  const settingsOpen = params.has("settings");

  const select = (next: Selection) => {
    setParams(
      () => {
        const p = new URLSearchParams();
        if (next === "new") p.set("new", "");
        else if (next !== null) p.set("edit", next);
        return p;
      },
      { replace: next === null },
    );
  };

  /** Opens or closes the bucket settings, keeping the bucket that's open. */
  const openSettings = (open: boolean) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (open) p.set("settings", "");
        else p.delete("settings");
        return p;
      },
      { replace: !open },
    );
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between">
        <Title order={2}>{t("nav.items.bucketSetup")}</Title>
        <Group gap="sm">
          {isDesktop ? (
            <Button
              variant="default"
              leftSection={<IconSettings size={16} />}
              onClick={() => {
                openSettings(true);
              }}
            >
              {t("bucketSetup.settings.open")}
            </Button>
          ) : (
            <ActionIcon
              variant="default"
              size={36}
              aria-label={t("bucketSetup.settings.open")}
              onClick={() => {
                openSettings(true);
              }}
            >
              <IconSettings size={18} />
            </ActionIcon>
          )}
          <Button
            leftSection={<IconPlus size={16} />}
            disabled={accounts.data?.length === 0}
            onClick={() => {
              select("new");
            }}
          >
            {t("bucketSetup.newBucket")}
          </Button>
        </Group>
      </Group>
      <BucketSettingsDrawer
        opened={settingsOpen}
        onClose={() => {
          openSettings(false);
        }}
      />
      <QueryState query={accounts}>
        {(accountList) => (
          <QueryState query={buckets}>
            {(bucketList) => {
              if (accountList.length === 0) {
                return (
                  <Text c="dimmed">
                    <Trans
                      i18nKey="bucketSetup.needAccount"
                      components={{ setup: <Anchor component={Link} to="/accounts/setup" /> }}
                    />
                  </Text>
                );
              }
              const editing =
                selection && selection !== "new"
                  ? bucketList.find((b) => b.id === selection)
                  : undefined;
              const open = selection === "new" || editing !== undefined;
              const form = open && (
                <BucketForm
                  key={editing?.id ?? "new"}
                  bucket={editing}
                  accounts={accountList}
                  onDone={(saved) => {
                    select(isDesktop ? saved : null);
                  }}
                  onOpenSettings={() => {
                    openSettings(true);
                  }}
                />
              );
              const list = (
                <BucketList
                  accounts={accountList}
                  buckets={bucketList}
                  selected={editing?.id ?? null}
                  onSelect={select}
                />
              );

              if (!isDesktop) {
                return (
                  <>
                    {list}
                    <ResponsiveModal
                      opened={open}
                      title={<FormTitle bucket={editing} />}
                      onClose={() => {
                        select(null);
                      }}
                    >
                      {form}
                    </ResponsiveModal>
                  </>
                );
              }
              return (
                <Group align="flex-start" gap="lg" wrap="nowrap">
                  <Box w={320} style={{ flexShrink: 0 }}>
                    {list}
                  </Box>
                  <Card withBorder style={{ flex: 1, minWidth: 0 }}>
                    {form ? (
                      <Stack gap="md">
                        <Title order={3} size="h4">
                          <FormTitle bucket={editing} />
                        </Title>
                        {form}
                      </Stack>
                    ) : (
                      <Text c="dimmed">{t("bucketSetup.pick")}</Text>
                    )}
                  </Card>
                </Group>
              );
            }}
          </QueryState>
        )}
      </QueryState>
    </Stack>
  );
}

function BucketList({
  accounts,
  buckets,
  selected,
  onSelect,
}: {
  accounts: Account[];
  buckets: Bucket[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (buckets.length === 0) {
    return (
      <Card withBorder>
        <Text c="dimmed">{t("bucketSetup.empty")}</Text>
      </Card>
    );
  }
  return (
    <Card withBorder padding="xs">
      <Stack gap="sm">
        {accounts
          .filter((a) => buckets.some((b) => b.source_account_id === a.id))
          .map((a) => (
            <nav key={a.id} aria-label={a.name}>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" py={4}>
                {a.name}
              </Text>
              {buckets
                .filter((b) => b.source_account_id === a.id)
                .map((b) => (
                  <NavLink
                    key={b.id}
                    component="button"
                    type="button"
                    label={
                      <>
                        {b.name}{" "}
                        <Text span size="sm" c="dimmed">
                          (#{b.id})
                        </Text>
                      </>
                    }
                    active={b.id === selected}
                    aria-current={b.id === selected ? "true" : undefined}
                    rightSection={
                      <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                        {b.refill_mode === "fully_manual"
                          ? refillModeLabel(b.refill_mode)
                          : formatMoney(b.refill_amount, b.currency)}
                      </Text>
                    }
                    onClick={() => {
                      onSelect(b.id);
                    }}
                  />
                ))}
            </nav>
          ))}
      </Stack>
    </Card>
  );
}
