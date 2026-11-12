import { Button, Card, Group, Paper, Stack, Text } from "@mantine/core";
import { IconPencil } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { ModuleBody } from "@/components/reports/ModuleCard";
import { ModuleEditor } from "@/components/reports/ModuleEditor";
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
 * reports don't have), and the module, which Edit changes as a report's
 * module is. A saved one (`selected`) saves both; an unsaved one is saved
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
  const [editing, setEditing] = useState(false);
  const report = useMemo(() => savedModuleReport(draft), [draft]);
  // Once per change: a period that's still going ends now.
  const periods = useMemo(() => savedModulePeriods(draft, cycles), [draft, cycles]);
  const choice = parsePeriod(draft.period) ?? defaultPeriod(cycles);

  return (
    <Stack gap="md">
      <SavedModules
        saved={saved}
        current={draft}
        selectedId={selected?.id ?? null}
        onSelect={onSelect}
      />
      <Paper withBorder p="md">
        <Stack gap="xs">
          <PeriodPicker
            value={choice}
            cycles={cycles}
            onChange={(c) => {
              setDraft({ ...draft, period: formatPeriod(c) });
            }}
          />
          <Text size="xs" c="dimmed">
            {t("stats.saved.periodHint")}
          </Text>
        </Stack>
      </Paper>
      <Card withBorder padding="md" component="section" aria-label={moduleTitle(draft.module)}>
        <Stack gap="sm">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Text component="h3" m={0} fw={600} style={{ minWidth: 0 }}>
              {moduleTitle(draft.module)}
            </Text>
            <Button
              variant="default"
              size="xs"
              leftSection={<IconPencil size={14} />}
              onClick={() => {
                setEditing(true);
              }}
            >
              {t("stats.saved.editModule")}
            </Button>
          </Group>
          <ModuleBody
            report={report}
            module={draft.module}
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
      <ModuleEditor
        module={editing ? draft.module : null}
        adding={false}
        report={report}
        choice={periods.choice}
        period={periods.period}
        comparable={periods.compare !== null}
        cycles={cycles}
        accounts={accounts}
        buckets={buckets}
        tags={tags}
        standalone
        onApply={(m) => {
          // The editor offers no section here.
          if (m.type !== "section") setDraft({ ...draft, module: m });
          setEditing(false);
        }}
        onClose={() => {
          setEditing(false);
        }}
      />
    </Stack>
  );
}
