// What kind of device the app runs on, for the few things that differ.

/** Whether the main pointer is a finger: phones and tablets. */
export function isTouch(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Props that focus a field when its dialog or form opens (Mantine's
 * data-autofocus), except on touch screens, where that would pop up the
 * keyboard straight away.
 */
export function autofocusField(): { "data-autofocus"?: true } {
  return isTouch() ? {} : { "data-autofocus": true };
}
