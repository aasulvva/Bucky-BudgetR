import { Input, SegmentedControl, Select, useMantineTheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useTranslation } from "react-i18next";

import { PART_MODULE_TYPES, type PartModule } from "@/lib/reports";

/**
 * The Stats tab's module type (#204): a graph, or a transactions, in/out/
 * balance or budget vs spending module. Buttons where they fit, a select
 * on narrower screens.
 */
export function ModuleTypeSwitch({
  value,
  onChange,
}: {
  value: PartModule["type"];
  onChange: (type: PartModule["type"]) => void;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const wide = useMediaQuery(`(min-width: ${theme.breakpoints.md})`, true);
  const data = PART_MODULE_TYPES.map((v) => ({
    value: v,
    label: t(`stats.reports.module.types.${v}`),
  }));
  const pick = (v: string | null) => {
    const type = PART_MODULE_TYPES.find((x) => x === v);
    if (type && type !== value) onChange(type);
  };
  return wide ? (
    <Input.Wrapper label={t("stats.type")}>
      <div>
        <SegmentedControl data={data} value={value} onChange={pick} />
      </div>
    </Input.Wrapper>
  ) : (
    <Select
      // In place, as in a drawer on phones (#122's touch fix).
      comboboxProps={{ withinPortal: false }}
      label={t("stats.type")}
      data={data}
      value={value}
      allowDeselect={false}
      onChange={pick}
      w={260}
    />
  );
}
