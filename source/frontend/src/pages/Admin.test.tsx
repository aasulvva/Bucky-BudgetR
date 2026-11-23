import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AdminUser } from "@/api/admin";
import { apiMock, problem, testUser } from "@/test/api";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";
import { formatDateTime } from "@/lib/dates";

const me = { ...testUser, id: "100001", username: "admin", admin: true };

function user(overrides: Partial<AdminUser> & Pick<AdminUser, "id" | "username">): AdminUser {
  return {
    active: true,
    admin: false,
    must_change_password: false,
    created_at: "2026-10-01T08:00:00Z",
    created_by: me.id,
    last_seen_at: null,
    ...overrides,
  };
}

const admin = user({
  id: me.id,
  username: "admin",
  admin: true,
  created_by: null,
  last_seen_at: "2026-10-26T20:15:00Z",
});
const kari = user({ id: "100002", username: "kari", must_change_password: true });
const ola = user({ id: "100003", username: "ola", active: false });

beforeEach(() => {
  apiMock.on("GET /api/v1/me", { body: me });
  apiMock.on("GET /api/v1/admin/users", { body: [admin, kari, ola] });
});

afterEach(() => {
  viewport.width = 1280;
});

async function row(name: string) {
  const cell = await screen.findByText(name, { selector: "span" });
  const tr = cell.closest("tr");
  if (!tr) throw new Error(`no row for ${name}`);
  return within(tr);
}

async function openMenu(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
}

describe("Admin", () => {
  it("lists the users", async () => {
    renderRoute("/admin");
    const a = await row("admin");
    expect(a.getByText("(#100001)")).toBeInTheDocument();
    expect(a.getByText("You")).toBeInTheDocument();
    expect(a.getByText("Admin")).toBeInTheDocument();
    expect(a.getByText(formatDateTime("2026-10-26T20:15:00Z"))).toBeInTheDocument();

    const k = await row("kari");
    expect(k.getByText("Must change password")).toBeInTheDocument();
    expect(k.getByText("Never")).toBeInTheDocument();
    expect(k.getByText(formatDateTime("2026-10-01T08:00:00Z"))).toBeInTheDocument();
    expect(k.queryByText("You")).not.toBeInTheDocument();

    expect((await row("ola")).getByText("Inactive")).toBeInTheDocument();
  });

  it("creates a user and shows the temporary password once", async () => {
    apiMock.on("POST /api/v1/admin/users", {
      status: 201,
      body: {
        user: user({ id: "100004", username: "per", admin: true }),
        temporary_password: "k7Qm-2xTf-Rw9b-HnP4",
      },
    });
    renderRoute("/admin");
    await userEvent.click(await screen.findByRole("button", { name: "New user" }));
    const dialog = within(await screen.findByRole("dialog"));

    await userEvent.type(dialog.getByRole("textbox", { name: /Username/ }), "no spaces");
    await userEvent.click(dialog.getByRole("button", { name: "Create user" }));
    expect(apiMock.calls("POST /api/v1/admin/users")).toHaveLength(0);

    await userEvent.clear(dialog.getByRole("textbox", { name: /Username/ }));
    await userEvent.type(dialog.getByRole("textbox", { name: /Username/ }), "per");
    await userEvent.click(dialog.getByRole("checkbox", { name: /Admin/ }));
    await userEvent.click(dialog.getByRole("radio", { name: /Temporary password/ }));
    await userEvent.click(dialog.getByRole("button", { name: "Create user" }));

    expect(await screen.findByTestId("temporary-password")).toHaveTextContent(
      "k7Qm-2xTf-Rw9b-HnP4",
    );
    expect(apiMock.calls("POST /api/v1/admin/users")[0]?.body).toEqual({
      username: "per",
      admin: true,
      credential: "password",
    });
    expect(screen.getByRole("button", { name: "Copy the password" })).toBeInTheDocument();
    expect(screen.getByText(/only time it's shown/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("temporary-password")).not.toBeInTheDocument();
  });

  it("creates a user with a setup link by default", async () => {
    const token = "xC9v3gInhD6Z6seIVchYN79dotG3LzQfWKKhmZscPKc";
    apiMock.on("POST /api/v1/admin/users", {
      status: 201,
      body: {
        user: user({ id: "100004", username: "per" }),
        link: { token, expires_at: "2026-10-27T22:00:00Z" },
      },
    });
    renderRoute("/admin");
    await userEvent.click(await screen.findByRole("button", { name: "New user" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("radio", { name: /Link/ })).toBeChecked();
    await userEvent.type(dialog.getByRole("textbox", { name: /Username/ }), "per");
    await userEvent.click(dialog.getByRole("button", { name: "Create user" }));

    expect(await screen.findByTestId("password-link")).toHaveTextContent(
      `${window.location.origin}/set-password#${token}`,
    );
    expect(screen.getByRole("dialog", { name: "Link for per" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the link" })).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`until ${formatDateTime("2026-10-27T22:00:00Z")}`)),
    ).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/admin/users")[0]?.body).toEqual({
      username: "per",
      admin: false,
      credential: "link",
    });
  });

  it("shows a taken username on the field", async () => {
    apiMock.on("POST /api/v1/admin/users", problem(409, "username_taken", "Username taken."));
    renderRoute("/admin");
    await userEvent.click(await screen.findByRole("button", { name: "New user" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.type(dialog.getByRole("textbox", { name: /Username/ }), "Kari");
    await userEvent.click(dialog.getByRole("button", { name: "Create user" }));
    expect(await dialog.findByText("That username is already in use.")).toBeInTheDocument();
  });

  it("deactivates a user after asking", async () => {
    apiMock.on("PATCH /api/v1/admin/users/100002", { body: { ...kari, active: false } });
    renderRoute("/admin");
    await openMenu("kari");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Deactivate" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Deactivate kari?" }));
    expect(apiMock.calls("PATCH /api/v1/admin/users/100002")).toHaveLength(0);
    await userEvent.click(dialog.getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByText("kari is deactivated.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/admin/users/100002")[0]?.body).toEqual({ active: false });
  });

  it("activates and promotes at once", async () => {
    apiMock.on("PATCH /api/v1/admin/users/100003", { body: { ...ola, active: true } });
    apiMock.on("PATCH /api/v1/admin/users/100002", { body: { ...kari, admin: true } });
    renderRoute("/admin");
    await openMenu("ola");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Activate" }));
    expect(await screen.findByText("ola can log in again.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/admin/users/100003")[0]?.body).toEqual({ active: true });

    await openMenu("kari");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Make admin" }));
    expect(await screen.findByText("kari is now an admin.")).toBeInTheDocument();
    expect(apiMock.calls("PATCH /api/v1/admin/users/100002")[0]?.body).toEqual({ admin: true });
  });

  it("resets a password after asking", async () => {
    apiMock.on("POST /api/v1/admin/users/100002/reset-password", (req) => ({
      body:
        (req.body as { credential: string }).credential === "link"
          ? { link: { token: "A".repeat(43), expires_at: "2026-10-27T22:00:00Z" } }
          : { temporary_password: "abcd-efgh-ijkm-npqr" },
    }));
    renderRoute("/admin");
    await openMenu("kari");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reset password" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "Reset the password for kari?" }),
    );
    expect(dialog.getByText(/stops working at once/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole("radio", { name: /Temporary password/ }));
    await userEvent.click(dialog.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByTestId("temporary-password")).toHaveTextContent(
      "abcd-efgh-ijkm-npqr",
    );
    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    // A reset link, the default.
    await openMenu("kari");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reset password" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Reset password" }),
    );
    expect(await screen.findByTestId("password-link")).toHaveTextContent(
      `/set-password#${"A".repeat(43)}`,
    );
    expect(
      apiMock.calls("POST /api/v1/admin/users/100002/reset-password").map((r) => r.body),
    ).toEqual([{ credential: "password" }, { credential: "link" }]);
  });

  it("doesn't change your own account", async () => {
    renderRoute("/admin");
    await openMenu("admin");
    expect(await screen.findByText(/This is you/)).toBeInTheDocument();
    for (const name of ["Remove admin", "Reset password", "Deactivate"]) {
      expect(screen.getByRole("menuitem", { name })).toBeDisabled();
    }
  });

  it("explains a refused change", async () => {
    apiMock.on(
      "PATCH /api/v1/admin/users/100002",
      problem(409, "last_admin", "This is the last active admin."),
    );
    renderRoute("/admin");
    await openMenu("kari");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Deactivate" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("button", { name: "Deactivate" }));
    expect(
      await dialog.findByText("This is the last active admin. Make someone else an admin first."),
    ).toBeInTheDocument();
  });

  it("is for admins only", async () => {
    apiMock.on("GET /api/v1/me", { body: testUser });
    renderRoute("/admin");
    expect(await screen.findByText("Admins only")).toBeInTheDocument();
    expect(apiMock.calls("GET /api/v1/admin/users")).toHaveLength(0);
  });

  it("shows cards on mobile", async () => {
    viewport.width = 390;
    renderRoute("/admin");
    expect(await screen.findAllByText("Last seen: Never")).toHaveLength(2);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for kari" })).toBeInTheDocument();
  });

  it("speaks nynorsk", async () => {
    apiMock.on("GET /api/v1/me", {
      body: { ...me, preferences: { ...me.preferences, language: "nn" } },
    });
    renderRoute("/admin");
    expect(await screen.findByRole("button", { name: "Ny brukar" })).toBeInTheDocument();
    expect(await screen.findByText("Må byte passord")).toBeInTheDocument();
  });

  describe("BSU rules (#214)", () => {
    const rule = (from_year: number, yearly_limit: string, total_limit = "300000.00") => ({
      from_year,
      yearly_limit,
      total_limit,
      modified_at: "2026-01-01T08:00:00Z",
    });

    it("lists the rules, and the last one can't be deleted", async () => {
      apiMock.on("GET /api/v1/admin/bsu-rules", { body: [rule(2021, "27500.00")] });
      renderRoute("/admin/bsu");
      expect(
        await screen.findByRole("tab", { name: "BSU rules", selected: true }),
      ).toBeInTheDocument();
      expect(await screen.findByRole("cell", { name: "2021" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Delete the rule from 2021" })).toBeDisabled();
    });

    it("adds a rule, checking the limits", async () => {
      apiMock.on("GET /api/v1/admin/bsu-rules", { body: [rule(2021, "27500.00")] });
      apiMock.on("PUT /api/v1/admin/bsu-rules/2027", { body: rule(2027, "30000.00", "350000.00") });
      renderRoute("/admin/bsu");
      await userEvent.click(await screen.findByRole("button", { name: "Add rule" }));
      const dialog = within(await screen.findByRole("dialog", { name: "New rule" }));
      expect(dialog.getByRole("textbox", { name: "From year" })).toHaveValue("2022");
      const year = dialog.getByRole("textbox", { name: "From year" });
      await userEvent.clear(year);
      await userEvent.type(year, "2027");
      const yearly = dialog.getByRole("textbox", { name: "Yearly limit" });
      await userEvent.clear(yearly);
      await userEvent.type(yearly, "400000");
      expect(
        dialog.getByText("The total limit can't be below the yearly limit."),
      ).toBeInTheDocument();
      await userEvent.clear(yearly);
      await userEvent.type(yearly, "30000");
      const total = dialog.getByRole("textbox", { name: "Total limit" });
      await userEvent.clear(total);
      await userEvent.type(total, "350000");
      await userEvent.click(dialog.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("The BSU rule from 2027 is saved.")).toBeInTheDocument();
      expect(apiMock.calls("PUT /api/v1/admin/bsu-rules/2027")[0]?.body).toEqual({
        yearly_limit: "30000.00",
        total_limit: "350000.00",
      });
    });

    it("deletes a rule", async () => {
      apiMock.on("GET /api/v1/admin/bsu-rules", {
        body: [rule(2016, "25000.00"), rule(2021, "27500.00")],
      });
      apiMock.on("DELETE /api/v1/admin/bsu-rules/2016", { status: 204 });
      renderRoute("/admin/bsu");
      await userEvent.click(
        await screen.findByRole("button", { name: "Delete the rule from 2016" }),
      );
      const dialog = within(
        await screen.findByRole("dialog", { name: "Delete the rule from 2016" }),
      );
      await userEvent.click(dialog.getByRole("button", { name: "Delete" }));
      expect(await screen.findByText("The BSU rule from 2016 is deleted.")).toBeInTheDocument();
      expect(apiMock.calls("DELETE /api/v1/admin/bsu-rules/2016")).toHaveLength(1);
    });
  });
});
