import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import dayjs from "dayjs";
import { useState } from "react";

import type { Cycle } from "@/api/cycles";
import { addDays, cycleRange, endAtFor, formatDateRange, startAtFor, today } from "@/lib/cycles";
import { MAX_BARS, type PeriodChoice, type Resolution } from "@/lib/periods";
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
        choice={choice}
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

/** Picks a kind of period, then its unit. */
async function choose(kind: string, unit?: string) {
  await pick("Period", kind);
  if (unit) await pick("Unit", unit);
}

describe("PeriodPicker", () => {
  it("picks a kind and unit and shows its dates", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Harness initial={{ kind: "current", unit: "month" }} onChange={onChange} />,
    );
    expect(screen.getByRole("combobox", { name: "Period" })).toHaveValue("This");
    expect(screen.getByRole("combobox", { name: "Unit" })).toHaveValue("Month");
    // Changing the kind keeps the unit.
    await choose("Previous");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "previous", unit: "month" });
    await choose("Previous", "Year");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "previous", unit: "year" });
    const year = new Date().getFullYear() - 1;
    expect(screen.getByTestId("period-range").textContent).toBe(
      formatDateRange(`${year}-01-01`, `${year}-12-31`),
    );
  });

  it("lists the units shortest first", async () => {
    renderWithProviders(<Harness initial={{ kind: "current", unit: "month" }} />);
    const units = async () => {
      await userEvent.click(screen.getByRole("combobox", { name: "Unit" }));
      const shown = (await screen.findAllByRole("option")).map((o) => o.textContent);
      await userEvent.keyboard("{Escape}");
      return shown;
    };
    const one = ["Day", "Week", "Cycle", "Month", "Quarter", "Half-year", "Year"];
    expect(await units()).toEqual(one);
    await choose("Previous");
    expect(await units()).toEqual(one);
    await choose("Last");
    expect(await units()).toEqual([
      "Days",
      "Weeks",
      "Cycles",
      "Months",
      "Quarters",
      "Half-years",
      "Years",
    ]);
  });

  it("asks how many for the last days, weeks or months, within limits", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Harness initial={{ kind: "current", unit: "month" }} onChange={onChange} />,
    );
    await choose("Last", "Weeks");
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
    await choose("This", "Cycle");
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

  it("picks a specific month and steps through months, not past today", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Harness initial={{ kind: "current", unit: "month" }} onChange={onChange} />,
    );
    await choose("Specific");
    const thisMonth = dayjs().startOf("month").format("YYYY-MM-DD");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "specific", unit: "month", at: thisMonth });
    expect(screen.getByRole("button", { name: "Step forward" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Step back" }));
    const lastMonth = dayjs().startOf("month").subtract(1, "month");
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "specific",
      unit: "month",
      at: lastMonth.format("YYYY-MM-DD"),
    });
    expect(screen.getByTestId("period-range").textContent).toBe(
      formatDateRange(
        lastMonth.format("YYYY-MM-DD"),
        lastMonth.endOf("month").format("YYYY-MM-DD"),
      ),
    );
    expect(screen.getByRole("button", { name: "Step forward" })).toBeEnabled();
  });

  it("picks a quarter by year and number", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Harness
        initial={{ kind: "specific", unit: "quarter", at: "2025-04-01" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Quarter" })).toHaveValue("Q2");
    await pick("Quarter", "Q4");
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "specific",
      unit: "quarter",
      at: "2025-10-01",
    });
    expect(screen.getByTestId("period-range").textContent).toBe(
      formatDateRange("2025-10-01", "2025-12-31"),
    );
  });

  it("picks a cycle from the list, newest first", async () => {
    const onChange = vi.fn();
    const active = cycle({ id: "100001000002" });
    const old = cycle({
      id: "100001000001",
      state: "finished",
      start_at: startAtFor(addDays(today(), -40)),
      end_at: endAtFor(addDays(today(), -11)),
    });
    renderWithProviders(
      <Harness
        initial={{ kind: "current", unit: "cycle" }}
        cycles={[old, active]}
        onChange={onChange}
      />,
    );
    await choose("Specific");
    expect(onChange).toHaveBeenLastCalledWith({ kind: "specific", unit: "cycle", at: active.id });
    await userEvent.click(screen.getByRole("combobox", { name: "Cycle" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual([cycleRange(active), cycleRange(old)]);
    await userEvent.click(screen.getByRole("option", { name: cycleRange(old) }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "specific", unit: "cycle", at: old.id });
    expect(screen.getByRole("button", { name: "Step back" })).toBeDisabled();
  });

  it("starts custom dates from the shown ones, with no future days to pick", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Harness initial={{ kind: "last", unit: "days", count: 3 }} onChange={onChange} />,
    );
    await choose("Custom dates");
    expect(onChange).toHaveBeenLastCalledWith({
      kind: "custom",
      from: addDays(today(), -2),
      to: today(),
    });
    expect(screen.queryByRole("combobox", { name: "Unit" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /First and last day/ }));
    // Mantine labels days "12 November 2026".
    const tomorrow = dayjs(addDays(today(), 1)).format("D MMMM YYYY");
    const days = screen.queryAllByRole("button", { name: tomorrow });
    expect(days.length).toBeGreaterThan(0);
    for (const d of days) expect(d).toBeDisabled();
  });
});

describe("ResolutionPicker", () => {
  it("offers every resolution the period allows, and switches when the value no longer does", async () => {
    const onResolution = vi.fn();
    renderWithProviders(
      <Harness
        initial={{ kind: "last", unit: "days", count: 30 }}
        resolution="month"
        onResolution={onResolution}
      />,
    );
    const showPer = () => screen.getByRole("combobox", { name: "Show per" });
    const options = async () => {
      await userEvent.click(showPer());
      const shown = (await screen.findAllByRole("option")).map((o) => o.textContent);
      await userEvent.keyboard("{Escape}");
      return shown;
    };
    expect(showPer()).toHaveValue("Month");
    // Today has no months: a day starts per hour.
    await choose("This");
    expect(onResolution).toHaveBeenLastCalledWith("hour");
    expect(showPer()).toHaveValue("Hour");
    expect(await options()).toEqual(["Hour", "Day", "Whole period"]);
    // Per hour still makes sense for a week; per week now does too, per month not.
    await pick("Unit", "Week");
    expect(showPer()).toHaveValue("Hour");
    expect(await options()).toEqual(["Hour", "Day", "Week", "Whole period"]);
  });
});
