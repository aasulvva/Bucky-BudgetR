import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, testUser, type MockRequest } from "@/test/api";
import { renderRoute } from "@/test/render";

/** Answers a preferences PATCH as the API does: merged, null resets. */
function patchPreferences(initial: Record<string, unknown>) {
  let prefs = { ...testUser.preferences, ...initial };
  return (req: MockRequest) => {
    const merged = Object.entries({ ...prefs, ...(req.body as object) });
    prefs = Object.fromEntries(merged.filter(([, v]) => v !== null));
    return { body: prefs };
  };
}

describe("Settings", () => {
  it("saves a preference when it changes", async () => {
    apiMock.on("PATCH /api/v1/me/preferences", patchPreferences({ language: "en" }));
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

  it("sets what new Keep funds buckets do when overspent", async () => {
    apiMock.on("PATCH /api/v1/me/preferences", patchPreferences({}));
    renderRoute("/settings");
    const select = await screen.findByRole("combobox", { name: /Overspent buckets/ });
    expect(select).toHaveValue("Carry it as debt");
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "Clear it at the refill" }));
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      default_negative_tf: "clear",
    });

    await userEvent.click(screen.getByRole("combobox", { name: /Overspent buckets/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Carry it as debt" }));
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[1]?.body).toEqual({
      default_negative_tf: null,
    });
  });

  it("turns the What's New popup off and on", async () => {
    apiMock.on("PATCH /api/v1/me/preferences", patchPreferences({}));
    renderRoute("/settings");
    const toggle = await screen.findByRole("switch", { name: /Show What's New after updates/ });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      whats_new_popup: false,
    });
    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });
    await userEvent.click(toggle);
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[1]?.body).toEqual({
      whats_new_popup: null,
    });
  });

  it("switches the language, which follows the locale by default", async () => {
    apiMock.on("PATCH /api/v1/me/preferences", patchPreferences({}));
    renderRoute("/settings");

    // A Norwegian locale brings bokmål along.
    await userEvent.click(await screen.findByRole("combobox", { name: /Number and date format/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Norsk bokmål" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Innstillinger" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: /^Språk/ })).toHaveValue(
      "Samme som tall- og datoformatet",
    );
    expect(document.documentElement.lang).toBe("nb");

    // Nynorsk, chosen on its own.
    await userEvent.click(screen.getByRole("combobox", { name: /^Språk/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Norsk nynorsk" }));
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[1]?.body).toEqual({ language: "nn" });
    expect(await screen.findByRole("heading", { level: 2, name: "Innstillingar" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Periodar" })).toBeInTheDocument();
    expect(screen.getByText("Inntektsreglar")).toBeInTheDocument();

    // And back to following the locale.
    await userEvent.click(screen.getByRole("combobox", { name: /^Språk/ }));
    await userEvent.click(
      await screen.findByRole("option", { name: "Same som tal- og datoformatet" }),
    );
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[2]?.body).toEqual({ language: null });
    expect(await screen.findByRole("heading", { level: 2, name: "Innstillinger" })).toBeVisible();
  });

  it("edits the income rules", async () => {
    apiMock.on("GET /api/v1/me", {
      body: {
        ...testUser,
        preferences: {
          ...testUser.preferences,
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

  it("plans cycles from a rule, with a preview", async () => {
    apiMock.on("PATCH /api/v1/me/preferences", patchPreferences({}));
    apiMock.on("POST /api/v1/cycle-rule/periods", {
      body: [
        { start: "2026-10-23", end: "2026-11-24" },
        { start: "2026-11-25", end: "2026-12-22" },
      ],
    });
    renderRoute("/settings");
    await userEvent.click(await screen.findByRole("switch", { name: "Plan cycles from a rule" }));
    const preview = await screen.findByRole("list", { name: "Next cycles" });
    expect(await within(preview).findAllByRole("listitem")).toHaveLength(2);
    // English in the US: no Norwegian holidays.
    expect(apiMock.calls("POST /api/v1/cycle-rule/periods")[0]?.body).toEqual({
      rule: { day: 25, shift: "previous", holidays: "none", ahead: 3 },
      count: 4,
    });

    const day = screen.getByRole("textbox", { name: "Starts on day" });
    await userEvent.clear(day);
    expect(screen.getByText("Enter a day from 1 to 31.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save cycle rule" })).toBeDisabled();
    await userEvent.type(day, "1");
    await userEvent.click(screen.getByRole("button", { name: "Save cycle rule" }));
    expect(await screen.findByText("Cycle rule saved.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      cycle_rule: { day: 1, shift: "previous", holidays: "none", ahead: 3 },
    });

    // Off again.
    await userEvent.click(screen.getByRole("switch", { name: "Plan cycles from a rule" }));
    await userEvent.click(screen.getByRole("button", { name: "Save cycle rule" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences")[1]?.body).toEqual({ cycle_rule: null });
    });
  });

  it("shows the server status", async () => {
    renderRoute("/settings");
    expect(await screen.findByText("API and database are reachable.")).toBeInTheDocument();
  });
});
