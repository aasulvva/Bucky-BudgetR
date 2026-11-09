import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import dayjs from "dayjs";
import { useState } from "react";

import { renderWithProviders } from "@/test/render";
import { viewport } from "@/test/setup";

import { DateTimeInput } from "./DateTimeInput";

// 1 Oct 2026 08:30 local time, in the past so nothing is clamped.
const start = dayjs("2026-10-01 08:30").toISOString();

function Harness({ onValue }: { onValue: (v: string | null) => void }) {
  const [value, setValue] = useState<string | null>(start);
  return (
    <DateTimeInput
      label="When"
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue(v);
      }}
    />
  );
}

describe("DateTimeInput", () => {
  afterEach(() => {
    viewport.touch = false;
  });

  it("opens as a dialog on touch screens, where a whole time can be typed (#166)", async () => {
    viewport.touch = true;
    const onValue = vi.fn();
    renderWithProviders(<Harness onValue={onValue} />);

    await userEvent.click(screen.getByRole("button", { name: "When" }));
    const dialog = await screen.findByRole("dialog");
    expect(document.querySelector("[data-dates-modal]")).toBeInTheDocument();
    const [hours, minutes] = within(dialog).getAllByRole("spinbutton");
    if (!hours || !minutes) throw new Error("no time inputs");

    await userEvent.click(hours);
    await userEvent.keyboard("17");
    expect(minutes).toHaveFocus();
    await userEvent.keyboard("05");

    expect(hours).toHaveValue("17");
    expect(minutes).toHaveValue("05");
    expect(onValue).toHaveBeenLastCalledWith(dayjs("2026-10-01 17:05").toISOString());
  });

  it("opens as a dropdown elsewhere", async () => {
    renderWithProviders(<Harness onValue={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "When" }));
    expect(await screen.findAllByRole("spinbutton")).toHaveLength(2);
    // Mantine's dropdown is a dialog too; the date modal has its own marker.
    expect(document.querySelector("[data-dates-modal]")).not.toBeInTheDocument();
  });
});
