import { Text, TextInput, type TextInputProps } from "@mantine/core";
import { useState } from "react";

import { currencySymbol, formatAmountInput, parseAmount } from "@/lib/money";

interface AmountInputProps extends Omit<TextInputProps, "value" | "defaultValue" | "onChange"> {
  /** A canonical amount ("1234.50"), or null when empty or invalid. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** The currency whose symbol is shown; defaults to NOK. */
  currency?: string;
}

/**
 * Text input for money. It works on strings only, so amounts never pass
 * through a float. Accepts "1 234,5", "1234.50" and the like; shows the
 * amount formatted for the locale once the field loses focus.
 */
export function AmountInput({
  value,
  onChange,
  onBlur,
  error,
  currency,
  ...props
}: AmountInputProps) {
  const [text, setText] = useState(() => (value === null ? "" : formatAmountInput(value)));
  const [touched, setTouched] = useState(false);

  // Follow changes made from outside, e.g. a form reset.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    if (value !== parseAmount(text)) setText(value === null ? "" : formatAmountInput(value));
  }

  const invalid = text.trim() !== "" && parseAmount(text) === null;

  return (
    <TextInput
      inputMode="decimal"
      autoComplete="off"
      rightSection={
        <Text size="sm" c="dimmed">
          {currencySymbol(currency)}
        </Text>
      }
      {...props}
      value={text}
      error={
        error ?? (touched && invalid ? "Enter an amount with at most two decimals" : undefined)
      }
      onChange={(e) => {
        setText(e.currentTarget.value);
        onChange(e.currentTarget.value.trim() === "" ? null : parseAmount(e.currentTarget.value));
      }}
      onBlur={(e) => {
        setTouched(true);
        const parsed = parseAmount(text);
        if (parsed !== null) setText(formatAmountInput(parsed));
        onBlur?.(e);
      }}
    />
  );
}
