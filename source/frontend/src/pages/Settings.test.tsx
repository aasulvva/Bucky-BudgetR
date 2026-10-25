import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, testUser, type MockRequest } from "@/test/api";
import { renderRoute } from "@/test/render";

/** Answers a preferences PATCH as the API does: merged, null resets. */
function patchPreferences(initial: Record<string, unknown>) {
  let prefs = initial;
  return (req: MockRequest) => {
    const merged = Object.entries({ ...prefs, ...(req.body as object) });
    prefs = Object.fromEntries(merged.filter(([, v]) => v !== null));
    return { body: prefs };
  };
}

describe("Settings", () => {
  it("saves a preference when it changes", async () => {
    apiMock.on("PATCH /api/v1/me/preferences", patchPreferences({}));
    renderRoute("/settings");
    await userEvent.click(await screen.findByRole("combobox", { name: /Number and date format/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Norsk bokmål" }));
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({ locale: "nb-NO" });
    expect(await screen.findByRole("combobox", { name: /Number and date format/ })).toHaveValue(
      "Norsk bokmål",
    );

    await userEvent.click(screen.getByRole("combobox", { name: /Number and date format/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Browser default" }));
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[1]?.body).toEqual({ locale: null });
  });

  it("edits the income rules", async () => {
    apiMock.on("GET /api/v1/me", {
      body: {
        ...testUser,
        preferences: {
          income_refill_rules: [{ counterparty: "Employer AS", min_amount: "20000" }],
        },
      },
    });
    apiMock.on(
      "PATCH /api/v1/me/preferences",
      patchPreferences({
        income_refill_rules: [{ counterparty: "Employer AS", min_amount: "20000" }],
      }),
    );
    renderRoute("/settings");
    expect(await screen.findByDisplayValue("Employer AS")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save rules" });
    expect(save).toBeDisabled();

    // A new row must be filled in before it saves.
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await userEvent.click(save);
    expect(screen.getByText("Enter the counterparty.")).toBeInTheDocument();
    expect(screen.getByText("Enter an amount.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/me/preferences")).toHaveLength(0);

    // The new row's fields are the ones with the errors.
    await userEvent.type(
      screen.getByRole("textbox", { name: "Counterparty", description: /Enter the counterparty/ }),
      " Side job ",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "At least", description: /Enter an amount/ }),
      "1500",
    );
    await userEvent.click(save);
    expect(await screen.findByText("Income rules saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      income_refill_rules: [
        { counterparty: "Employer AS", min_amount: "20000" },
        { counterparty: "Side job", min_amount: "1500.00" },
      ],
    });

    // Removing them all clears the rules.
    await userEvent.click(screen.getByRole("button", { name: "Remove rule 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove rule 1" }));
    expect(screen.getByText(/No rules yet\./)).toBeInTheDocument();
    await userEvent.click(save);
    await screen.findByText(/No rules yet\./);
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[1]?.body).toEqual({
      income_refill_rules: null,
    });
  });

  it("formats amounts in the chosen locale at once", async () => {
    const prefs = { income_refill_rules: [{ counterparty: "Employer AS", min_amount: "20000" }] };
    apiMock.on("GET /api/v1/me", { body: { ...testUser, preferences: prefs } });
    apiMock.on("PATCH /api/v1/me/preferences", patchPreferences(prefs));
    renderRoute("/settings");
    expect(await screen.findByDisplayValue("20,000.00")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: /Number and date format/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Deutsch" }));
    expect(await screen.findByDisplayValue("20.000,00")).toBeInTheDocument();
  });

  it("changes the password", async () => {
    apiMock.on("POST /api/v1/me/password", { status: 204 });
    renderRoute("/settings");
    // The only password form on the page.
    const card = (await screen.findByRole("button", { name: "Change password" })).closest(
      "form",
    ) as HTMLElement;
    await userEvent.type(within(card).getByLabelText(/Current password/), "old long password");
    await userEvent.type(within(card).getByLabelText(/^New password/), "new long password");
    await userEvent.type(within(card).getByLabelText(/Repeat/), "new long password");
    await userEvent.click(within(card).getByRole("button", { name: "Change password" }));
    expect(
      await screen.findByText("Password changed. Your other sessions were signed out."),
    ).toBeInTheDocument();
    expect(within(card).getByLabelText(/Current password/)).toHaveValue("");
  });

  it("shows the server status", async () => {
    renderRoute("/settings");
    expect(await screen.findByText("API and database are reachable.")).toBeInTheDocument();
  });
});
