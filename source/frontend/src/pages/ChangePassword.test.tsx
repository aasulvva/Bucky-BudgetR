import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem, testUser } from "@/test/api";
import { renderRoute } from "@/test/render";

const mustChange = { body: { ...testUser, must_change_password: true } };

async function fill(current: string, next: string, confirm = next) {
  await userEvent.type(await screen.findByLabelText(/Current password/), current);
  await userEvent.type(screen.getByLabelText(/^New password/), next);
  await userEvent.type(screen.getByLabelText(/Repeat the new password/), confirm);
  await userEvent.click(screen.getByRole("button", { name: "Save and continue" }));
}

describe("ChangePassword", () => {
  beforeEach(() => {
    apiMock.on("GET /api/v1/me", mustChange);
  });

  it("changes the password and continues to the app", async () => {
    apiMock.on("POST /api/v1/me/password", () => {
      apiMock.on("GET /api/v1/me", { body: testUser });
      return { status: 204 };
    });
    const { router } = renderRoute("/change-password");
    await fill("initial password", "my own long password");
    expect(await screen.findByRole("heading", { level: 2, name: "Dashboard" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(apiMock.calls("POST /api/v1/me/password")[0]?.body).toEqual({
      current_password: "initial password",
      new_password: "my own long password",
    });
  });

  it("checks the new password before sending it", async () => {
    renderRoute("/change-password");
    await fill("initial password", "too short", "different");
    expect(await screen.findByText("Use at least 12 characters.")).toBeInTheDocument();
    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/me/password")).toHaveLength(0);
  });

  it("shows the server's verdict on its field", async () => {
    apiMock.on(
      "POST /api/v1/me/password",
      problem(400, "wrong_password", "The current password is wrong."),
    );
    renderRoute("/change-password");
    await fill("not it at all", "my own long password");
    expect(await screen.findByText("The current password is wrong.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Current password/)).toHaveAccessibleDescription(
      /The current password is wrong/,
    );
  });

  it("can sign out instead", async () => {
    const { router } = renderRoute("/change-password");
    await screen.findByRole("heading", { name: "Choose a new password" });
    apiMock.on("GET /api/v1/me", problem(401, "unauthenticated", "Log in first."));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("is only for users who must change it", async () => {
    apiMock.on("GET /api/v1/me", { body: testUser });
    const { router } = renderRoute("/change-password");
    await screen.findByRole("heading", { level: 2, name: "Dashboard" });
    expect(router.state.location.pathname).toBe("/");
  });
});
