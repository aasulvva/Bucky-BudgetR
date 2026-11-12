import {
  Button,
  Card,
  Drawer,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAdjustmentsHorizontal } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { ModuleBody } from "@/components/reports/ModuleCard";
import { MAX_MODULE_TITLE, ModuleFields } from "@/components/reports/ModuleEditor";
import { defaultPeriod, formatPeriod, parsePeriod } from "@/lib/periods";
import { moduleTitle } from "@/lib/reports";
import { savedModulePeriods, savedModuleReport, type SavedModule } from "@/lib/savedModules";

import { PeriodPicker } from "./PeriodPicker";
import { SavedModules } from "./SavedModules";

interface ModuleViewProps {
  saved: SavedModule[];
  onSelect: (s: SavedModule | null) => void;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  tags: string[];
  isDesktop: boolean;
}

/**
 * A saved module that isn't a graph (#201), on the Stats tab, changed on
 * screen until saved. Picking none (or deleting it) gives `onSelect` null
 * and what's on screen, which stays as an unsaved module.
 */
export function SavedModuleView({
  selected,
  onSelect,
  ...props
}: Omit<ModuleViewProps, "onSelect"> & {
  selected: SavedModule;
  onSelect: (s: SavedModule | null, shown: SavedModule) => void;
}) {
  const [draft, setDraft] = useState(selected);
  return (
    <ModuleView
      {...props}
      selected={selected}
      draft={draft}
      onDraft={setDraft}
      onSelect={(s) => {
        onSelect(s, draft);
      }}
    />
  );
}

/**
 * A module that isn't a graph on the Stats tab (#201, #204): its own
 * period, any a graph has (the last N days, weeks and so on too, which
 * reports don't have), and the module's settings beside it, applied as
 * they change, as a graph's are: in a panel on wide screens, in a drawer
 * on phones. A saved one (`selected`) saves both; an unsaved one is saved
 * as new.
 */
export function ModuleView({
  saved,
  selected,
  draft,
  onDraft: setDraft,
  onSelect,
  cycles,
  accounts,
  buckets,
  tags,
  isDesktop,
}: ModuleViewProps & {
  selected: SavedModule | null;
  draft: SavedModule;
  onDraft: (draft: SavedModule) => void;
}) {
  const { t } = useTranslation();
  const [drawer, setDrawer] = useState(false);
  const report = useMemo(() => savedModuleReport(draft), [draft]);
  // Once per change: a period that's still going ends now.
  const periods = useMemo(() => savedModulePeriods(draft, cycles), [draft, cycles]);
  const choice = parsePeriod(draft.period) ?? defaultPeriod(cycles);
  const module = draft.module;
  const tooLong = (module.title ?? "").trim().length > MAX_MODULE_TITLE;

  /** The period, the title and the module's fields, side by side unless narrow (#204). */
  const settings = (narrow: boolean) => (
    <SimpleGrid
      cols={narrow ? 1 : { base: 1, xs: 2, md: 3, lg: 4 }}
      spacing="sm"
      verticalSpacing="sm"
    >
      <Stack gap="sm">
        <PeriodPicker
          inline={narrow}
          value={choice}
          cycles={cycles}
          onChange={(c) => {
            setDraft({ ...draft, period: formatPeriod(c) });
          }}
        />
        <Text size="xs" c="dimmed">
          {t("stats.saved.periodHint")}
        </Text>
        <TextInput
          label={t("stats.reports.module.title")}
          description={t("stats.reports.module.titleHint")}
          value={module.title ?? ""}
          error={tooLong ? t("common.maxChars", { count: MAX_MODULE_TITLE }) : undefined}
          onChange={(e) => {
            const title = e.currentTarget.value;
            setDraft({ ...draft, module: { ...module, title } });
          }}
        />
      </Stack>
      {module.type !== "graph" && (
        <ModuleFields
          module={module}
          onChange={(m) => {
            setDraft({ ...draft, module: m });
          }}
          choice={periods.choice}
          period={periods.period}
          cycles={cycles}
          accounts={accounts}
          buckets={buckets}
          tags={tags}
          standalone
        />
      )}
    </SimpleGrid>
  );

  return (
    <Stack gap="md">
      <SavedModules
        saved={saved}
        current={draft}
        selectedId={selected?.id ?? null}
        onSelect={onSelect}
      />
      {isDesktop ? (
        <Paper withBorder p="md" data-testid="module-settings">
          {settings(false)}
        </Paper>
      ) : (
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm" c="dimmed" data-testid="module-summary" style={{ flex: 1, minWidth: 0 }}>
            {[t(`stats.reports.module.types.${module.type}`), periods.label].join(" · ")}
          </Text>
          <Button
            variant="default"
            size="xs"
            style={{ flexShrink: 0 }}
            leftSection={<IconAdjustmentsHorizontal size={16} />}
            onClick={() => {
              setDrawer(true);
            }}
          >
            {t("stats.saved.settings")}
          </Button>
        </Group>
      )}
      <Card withBorder padding="md" component="section" aria-label={moduleTitle(module)}>
        <Stack gap="sm">
          <Text component="h3" m={0} fw={600} style={{ minWidth: 0 }}>
            {moduleTitle(module)}
          </Text>
          <ModuleBody
            report={report}
            module={module}
            choice={periods.choice}
            period={periods.period}
            compare={periods.compare}
            cycles={cycles}
            accounts={accounts}
            buckets={buckets}
            isDesktop={isDesktop}
            headingLevel={4}
          />
        </Stack>
      </Card>
      {!isDesktop && (
        <Drawer
          opened={drawer}
          onClose={() => {
            setDrawer(false);
          }}
          position="bottom"
          size="90%"
          title={t("stats.saved.settings")}
        >
          {settings(true)}
        </Drawer>
      )}
    </Stack>
  );
}
