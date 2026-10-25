import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem, testUser } from "@/test/api";
import { renderRoute } from "@/test/render";

const loggedOut = problem(401, "unauthenticated", "Log in first.");

describe("the session guard", () => {
  it("sends a visitor to the login page and back afterwards", async () => {
    apiMock.on("GET /api/v1/me", loggedOut);
    const { router } = renderRoute("/accounts?sort=name");
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toBe("?next=%2Faccounts%3Fsort%3Dname");
    // No notice: the visitor wasn't logged in to begin with.
    expect(screen.queryByText(/session has ended/)).not.toBeInTheDocument();

    apiMock.on("POST /api/v1/auth/login", { body: testUser });
    await userEvent.type(screen.getByLabelText(/Username/), "kari");
    await userEvent.type(screen.getByLabelText(/Password/), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Accounts" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?sort=name");
  });

  it("sends a user who must change the password to the password page", async () => {
    apiMock.on("GET /api/v1/me", { body: { ...testUser, must_change_password: true } });
    const { router } = renderRoute("/buckets");
    expect(
      await screen.findByRole("heading", { name: "Choose a new password" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/change-password");
  });

  it("goes to the login page with a notice when the session ends", async () => {
    const { router } = renderRoute("/settings");
    await screen.findByRole("heading", { level: 2, name: "Settings" });

    // The session expires; the next request says so.
    apiMock.on("GET /api/v1/me", loggedOut);
    apiMock.on("PATCH /api/v1/me/preferences", loggedOut);
    await userEvent.click(screen.getByRole("combobox", { name: /Default refill mode/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Manual" }));

    expect(await screen.findByText("Your session has ended. Log in again.")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?next=%2Fsettings");
    // The session handles it; no error notification.
    expect(screen.queryByText("Log in first.")).not.toBeInTheDocument();
  });
});
