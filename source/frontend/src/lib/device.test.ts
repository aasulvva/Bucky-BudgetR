import { viewport } from "@/test/setup";

import { autofocusField } from "./device";

afterEach(() => {
  viewport.touch = false;
});

describe("autofocusField", () => {
  it("focuses the field, except on touch screens", () => {
    expect(autofocusField()).toEqual({ "data-autofocus": true });
    viewport.touch = true;
    expect(autofocusField()).toEqual({});
  });
});
