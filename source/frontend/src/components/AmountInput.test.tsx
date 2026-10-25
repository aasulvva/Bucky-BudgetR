import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { formatAmountInput } from "@/lib/money";
import { renderWithProviders } from "@/test/render";

import { AmountInput } from "./AmountInput";

function Harness({ onValue }: { onValue: (v: string | null) => void }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <AmountInput
      label="Amount"
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue(v);
      }}
    />
  );
}

describe("AmountInput", () => {
  it("emits canonical decimal strings and formats on blur", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Harness onValue={onValue} />);
    const input = screen.getByLabelText("Amount");

    await userEvent.type(input, "1 234,5");
    expect(onValue).toHaveBeenLastCalledWith("1234.50");

    await userEvent.tab();
    expect(input).toHaveValue(formatAmountInput("1234.50"));
  });

  it("emits null and shows an error for invalid input", async () => {
    const onValue = vi.fn();
    renderWithProviders(<Harness onValue={onValue} />);
    const input = screen.getByLabelText("Amount");

    await userEvent.type(input, "12.345");
    expect(onValue).toHaveBeenLastCalledWith(null);
    await userEvent.tab();
    expect(input).toHaveValue("12.345");
    expect(screen.getByText(/at most two decimals/)).toBeInTheDocument();
  });
});
