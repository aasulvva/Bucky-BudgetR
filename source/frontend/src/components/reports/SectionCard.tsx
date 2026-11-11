import { Accordion, Badge, Box, Button, Card, Group, Stack, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Account, Bucket } from "@/api/accounts";
import type { Cycle } from "@/api/cycles";
import { usePrintMode } from "@/lib/print";
import {
  MAX_SECTION_MODULES,
  MAX_SUB_PERIODS,
  moduleAnchor,
  moduleTitle,
  sectionAnchor,
  sectionLabel,
  sectionParts,
  type PartModule,
  type ReportSettings,
  type SectionModule,
  type SectionPart,
} from "@/lib/reports";

import { ModuleActions, ModuleCard } from "./ModuleCard";

interface SectionCardProps {
  report: ReportSettings;
  module: SectionModule;
  index: number;
  count: number;
  cycles: Cycle[];
  accounts: Account[];
  buckets: Bucket[];
  isDesktop: boolean;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  /** Its modules': add one, edit, move or remove one. */
  onAddModule: () => void;
  onEditModule: (m: PartModule) => void;
  onMoveModule: (index: number, direction: -1 | 1) => void;
  onRemoveModule: (id: string) => void;
}

const noop = () => undefined;

/**
 * A report section (#194): its modules, by title, to add, edit, move and
 * remove, then a part per month or cycle of the period with the modules
 * over it. On screen a part loads only while it's open, the newest at
 * first; in a PDF every part shows, each on a new page.
 */
export function SectionCard({
  report,
  module,
  index,
  count,
  cycles,
  accounts,
  buckets,
  isDesktop,
  onEdit,
  onMove,
  onRemove,
  onAddModule,
  onEditModule,
  onMoveModule,
  onRemoveModule,
}: SectionCardProps) {
  const { t } = useTranslation();
  const print = usePrintMode();
  const title = moduleTitle(module);
  const modules = module.section.modules;
  // Once per change: a part that's still going ends now, and a new now on
  // every render would be new queries on every render.
  const parts = useMemo(() => sectionParts(report, module, cycles), [report, module, cycles]);
  // Null: as at first, the newest part open.
  const [opened, setOpened] = useState<string[] | null>(null);
  const newest = parts.ok ? parts.parts.at(-1)?.part.choice.at : undefined;
  const open = opened ?? (newest === undefined ? [] : [newest]);

  const body = (p: SectionPart) => (
    <Stack gap="sm">
      {modules.map((m) => (
        <ModuleCard
          key={m.id}
          report={report}
          module={m}
          index={0}
          count={1}
          choice={p.part.choice}
          period={p.part.period}
          compare={p.compare}
          cycles={cycles}
          accounts={accounts}
          buckets={buckets}
          isDesktop={isDesktop}
          onEdit={noop}
          onMove={noop}
          onRemove={noop}
          actions={false}
          headingLevel={4}
        />
      ))}
    </Stack>
  );

  let content;
  if (modules.length === 0) {
    content = (
      <Text size="sm" c="dimmed">
        {t("stats.reports.section.noModules")}
      </Text>
    );
  } else if (!parts.ok) {
    content = (
      <Text size="sm" c="dimmed">
        {parts.reason === "many"
          ? t("stats.reports.section.many", { max: MAX_SUB_PERIODS })
          : t("stats.reports.section.none")}
      </Text>
    );
  } else if (print) {
    content = parts.parts.map((p) => (
      <Box key={p.part.choice.at} id={sectionAnchor(module.id, p.part.choice.at)} data-section-part>
        <PartTitle part={p} cycles={cycles} heading />
        {body(p)}
      </Box>
    ));
  } else {
    content = (
      <Accordion
        multiple
        variant="separated"
        order={3}
        value={open}
        onChange={setOpened}
        aria-label={t("stats.reports.section.parts")}
      >
        {parts.parts.map((p) => {
          const key = p.part.choice.at;
          return (
            <Accordion.Item key={key} value={key} data-section-part>
              <Accordion.Control>
                <PartTitle part={p} cycles={cycles} />
              </Accordion.Control>
              {/* Only an open part's modules, so only they load. */}
              <Accordion.Panel>{open.includes(key) && body(p)}</Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>
    );
  }

  return (
    <Card
      withBorder
      padding="md"
      aria-label={title}
      component="section"
      id={moduleAnchor(module.id)}
      data-report-module
      data-report-section
    >
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap="xs" style={{ minWidth: 0 }}>
            {/* A heading, for the PDF's outline (#193). */}
            <Text component="h2" m={0} fw={600}>
              {title}
            </Text>
            <Badge variant="light" size="sm">
              {t(`stats.reports.section.unit.options.${module.section.unit}`)}
            </Badge>
          </Group>
          {!print && (
            <ModuleActions
              first={index === 0}
              last={index === count - 1}
              onMove={onMove}
              onEdit={onEdit}
              onRemove={onRemove}
            />
          )}
        </Group>
        {!print && (
          <Stack gap={4} data-section-modules>
            <Text size="sm" fw={500}>
              {t("stats.reports.section.modules")}
            </Text>
            {modules.map((m, i) => (
              <Group
                key={m.id}
                justify="space-between"
                wrap="nowrap"
                gap="xs"
                px="xs"
                py={2}
                style={{
                  border: "1px solid var(--mantine-color-default-border)",
                  borderRadius: "var(--mantine-radius-sm)",
                }}
                data-section-module
              >
                <Text
                  size="sm"
                  style={{ minWidth: 0, overflowWrap: "anywhere" }}
                  data-section-module-title
                >
                  {moduleTitle(m)}
                </Text>
                <ModuleActions
                  name={moduleTitle(m)}
                  size="sm"
                  first={i === 0}
                  last={i === modules.length - 1}
                  onMove={(d) => {
                    onMoveModule(i, d);
                  }}
                  onEdit={() => {
                    onEditModule(m);
                  }}
                  onRemove={() => {
                    onRemoveModule(m.id);
                  }}
                />
              </Group>
            ))}
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                leftSection={<IconPlus size={14} />}
                disabled={modules.length >= MAX_SECTION_MODULES}
                aria-label={t("stats.reports.section.addTo", { section: title })}
                onClick={onAddModule}
              >
                {t("stats.reports.section.add")}
              </Button>
              {modules.length >= MAX_SECTION_MODULES && (
                <Text size="xs" c="dimmed">
                  {t("stats.reports.section.max", { max: MAX_SECTION_MODULES })}
                </Text>
              )}
            </Group>
          </Stack>
        )}
        {content}
      </Stack>
    </Card>
  );
}

/** A part's name, and *partial* where the period cuts it or it's still going. */
function PartTitle({
  part,
  cycles,
  heading,
}: {
  part: SectionPart;
  cycles: Cycle[];
  /** Its own h3, in a PDF; on screen the accordion gives the heading. */
  heading?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Group gap="xs" mb={heading ? "xs" : 0} data-section-part-title>
      <Text component={heading ? "h3" : "span"} m={0} fw={600} size="sm">
        {sectionLabel(part.part, cycles)}
      </Text>
      {part.part.partial && (
        <Badge variant="light" color="gray" size="xs">
          {t("stats.reports.partial")}
        </Badge>
      )}
    </Group>
  );
}
