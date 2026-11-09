import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem, testUser, type MockRequest } from "@/test/api";
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
    expect(screen.getByText("Perioderegel")).toBeInTheDocument();

    // And back to following the locale.
    await userEvent.click(screen.getByRole("combobox", { name: /^Språk/ }));
    await userEvent.click(
      await screen.findByRole("option", { name: "Same som tal- og datoformatet" }),
    );
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[2]?.body).toEqual({ language: null });
    expect(await screen.findByRole("heading", { level: 2, name: "Innstillinger" })).toBeVisible();
  });

  it("leaves the bucket defaults and income rules to Bucket setup (#102)", async () => {
    renderRoute("/settings");
    await screen.findByRole("combobox", { name: /Number and date format/ });
    expect(screen.queryByRole("combobox", { name: /Default refill mode/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Overspent buckets/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Income rules")).not.toBeInTheDocument();
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

  describe("data export and import", () => {
    const exported = {
      app: "bucky-budgetr",
      format: 1,
      user_id: testUser.id,
      username: "kari",
      exported_at: "2026-11-09T10:00:00Z",
      data: { tables: { bank_accounts: [{ id: "a1", opening: 1000.1 }], cycles: [{ id: "c1" }] } },
    };
    let downloads: string[];
    beforeEach(() => {
      downloads = [];
      URL.createObjectURL = vi.fn(() => "blob:export");
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        downloads.push(this.download);
      });
      apiMock.on("GET /api/v1/me/export", { body: exported });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const fileInput = () => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (!input) throw new Error("no file input");
      return input;
    };
    const today = () => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    it("downloads the user's data", async () => {
      renderRoute("/settings");
      await userEvent.click(await screen.findByRole("button", { name: "Download my data" }));
      expect(await screen.findByText("Your data is downloaded.")).toBeInTheDocument();
      expect(downloads).toEqual([`bucky-budgetr-kari-${today()}.json`]);
    });

    it("replaces the data after a typed confirmation, downloading it first", async () => {
      apiMock.on("POST /api/v1/me/import", () => {
        // The current data is already saved.
        expect(downloads).toHaveLength(1);
        return { body: { accounts: 1, buckets: 0, cycles: 1, transactions: 0, schedules: 0 } };
      });
      renderRoute("/settings");
      await screen.findByRole("button", { name: "Download my data" });
      const text = JSON.stringify({ ...exported, username: "ola", user_id: "other" });
      await userEvent.upload(
        fileInput(),
        new File([text], "backup.json", { type: "application/json" }),
      );

      const dialog = await screen.findByRole("dialog", { name: "Replace all your data?" });
      expect(within(dialog).getByText("ola")).toBeInTheDocument();
      expect(within(dialog).getByText(/imported as a copy with new IDs/)).toBeInTheDocument();
      expect(within(dialog).getByRole("row", { name: "Accounts 1" })).toBeInTheDocument();
      const confirm = within(dialog).getByRole("button", { name: "Replace my data" });
      expect(confirm).toBeDisabled();
      await userEvent.type(within(dialog).getByLabelText(/Type your username/), "kari");
      await userEvent.click(confirm);

      expect(
        await screen.findByText("Imported: 1 accounts and 0 transactions."),
      ).toBeInTheDocument();
      expect(apiMock.calls("POST /api/v1/me/import")[0]?.body).toEqual(JSON.parse(text));
      expect(apiMock.requests.map((r) => `${r.method} ${r.path}`)).toContain(
        "GET /api/v1/me/export",
      );
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
    });

    it("refuses a file that isn't an export", async () => {
      renderRoute("/settings");
      await screen.findByRole("button", { name: "Download my data" });
      await userEvent.upload(fileInput(), new File(["{}"], "x.json", { type: "application/json" }));
      expect(await screen.findByText(/isn't a Bucky BudgetR export/)).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows the server's answer when the import fails", async () => {
      apiMock.on("POST /api/v1/me/import", problem(409, "export_too_new", "Too new."));
      renderRoute("/settings");
      await screen.findByRole("button", { name: "Download my data" });
      await userEvent.upload(
        fileInput(),
        new File([JSON.stringify(exported)], "x.json", { type: "application/json" }),
      );
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByText(/new IDs/)).not.toBeInTheDocument();
      await userEvent.type(within(dialog).getByLabelText(/Type your username/), "kari");
      await userEvent.click(within(dialog).getByRole("button", { name: "Replace my data" }));
      expect(
        await within(dialog).findByText(/This export is from a newer version/),
      ).toBeInTheDocument();
    });
  });
});
