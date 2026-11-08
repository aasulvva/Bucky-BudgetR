import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import dayjs from "dayjs";
import { useState } from "react";

import type { Cycle } from "@/api/cycles";
import { addDays, formatDateRange, today } from "@/lib/cycles";
import { MAX_BARS, resolvePeriod, type PeriodChoice, type Resolution } from "@/lib/periods";
import { cycle } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

import { PeriodPicker } from "./PeriodPicker";
import { ResolutionPicker } from "./ResolutionPicker";

function Harness({
  initial,
  cycles = [],
  onChange,
  onResolution,
  resolution = "day",
}: {
  initial: PeriodChoice;
  cycles?: Cycle[];
  onChange?: (c: PeriodChoice) => void;
  onResolution?: (r: Resolution) => void;
  resolution?: Resolution;
}) {
  const [choice, setChoice] = useState(initial);
  const [res, setRes] = useState(resolution);
  return (
    <>
      <PeriodPicker
        value={choice}
        cycles={cycles}
        onChange={(c) => {
          onChange?.(c);
          setChoice(c);
        }}
      />
      <ResolutionPicker
        value={res}
        period={resolvePeriod(choice, cycles)}
        max={MAX_BARS}
        cycles={cycles}
        onChange={(r) => {
          onResolution?.(r);
          setRes(r);
        }}
      />
    </>
  );
}

async function pick(label: string | RegExp, option: string) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("PeriodPicker", () => {
  it("picks a calendar period and shows its dates", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Harness initial={{ kind: "current", unit: "month" }} onChange={onChange} />,
    );
    await pick("Period", "Previous year");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "previous", unit: "year" });
    const year = new Date().getFullYear() - 1;
    expect(screen.getByTestId("period-range").textContent).toBe(
      formatDateRange(`${year}-01-01`, `${year}-12-31`),
    );
  });

  it("asks how many for the last days, weeks or months, within limits", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Harness initial={{ kind: "current", unit: "month" }} onChange={onChange} />,
    );
    await pick("Period", "The last few weeks");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "last", unit: "weeks", count: 8 });
    const count = screen.getByRole("textbox", { name: /Number of weeks/ });
    await userEvent.clear(count);
    await userEvent.type(count, "999");
    const last = onChange.mock.lastCall?.[0] as PeriodChoice;
    expect(last.kind === "last" && last.count <= 104).toBe(true);
    expect(screen.getByText("This week included.")).toBeInTheDocument();
  });

  it("says so when there's no active cycle", async () => {
    renderWithProviders(<Harness initial={{ kind: "current", unit: "month" }} />);
    await pick("Period", "This cycle");
    expect(screen.getByTestId("period-range")).toHaveTextContent("There's no active cycle.");
    // Nothing to cut, so no resolution to pick.
    expect(screen.getByRole("combobox", { name: "Show per" })).toBeDisabled();
  });

  it("shows the active cycle", () => {
    const active = cycle();
    renderWithProviders(<Harness initial={{ kind: "current", unit: "cycle" }} cycles={[active]} />);
    expect(screen.getByTestId("period-range").textContent).toBe(
      formatDateRange(addDays(today(), -10), today()),
    );
  });

  it("starts custom dates from the shown ones, with no future days to pick", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Harness initial={{ kind: "last", unit: "days", count: 3 }} onChange={onChange} />,
    );
    await pick("Period", "Custom dates");
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "custom",
      from: addDays(today(), -2),
      to: today(),
    });
    await userEvent.click(screen.getByRole("button", { name: /First and last day/ }));
    // Mantine labels days "12 November 2026".
    const tomorrow = dayjs(addDays(today(), 1)).format("D MMMM YYYY");
    const days = screen.queryAllByRole("button", { name: tomorrow });
    expect(days.length).toBeGreaterThan(0);
    for (const d of days) expect(d).toBeDisabled();
  });
});

describe("ResolutionPicker", () => {
  it("offers only what fits, and switches when the value no longer does", async () => {
    const onResolution = vi.fn();
    renderWithProviders(
      <Harness
        initial={{ kind: "last", unit: "days", count: 30 }}
        resolution="day"
        onResolution={onResolution}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Show per" })).toHaveValue("Day");
    await pick("Period", "Previous year");
    // 365 days don't fit in 60 bars: months are the year's default.
    expect(onResolution).toHaveBeenLastCalledWith("month");
    expect(screen.getByRole("combobox", { name: "Show per" })).toHaveValue("Month");
    await userEvent.click(screen.getByRole("combobox", { name: "Show per" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Week", "Month", "Year", "Whole period"]);
  });
});
