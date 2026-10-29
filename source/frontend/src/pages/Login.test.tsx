import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { APP_VERSION } from "@/lib/changelog";
import { apiMock, problem, testUser } from "@/test/api";
import { renderRoute } from "@/test/render";

beforeEach(() => {
  apiMock.on("GET /api/v1/me", problem(401, "unauthenticated", "Log in first."));
});

async function logIn(username = "kari", password = "a long password") {
  await userEvent.type(await screen.findByLabelText(/Username/), username);
  await userEvent.type(screen.getByLabelText(/Password/), password);
  await userEvent.click(screen.getByRole("button", { name: "Log in" }));
}

describe("Login", () => {
  it("logs in and goes to the dashboard", async () => {
    apiMock.on("POST /api/v1/auth/login", { body: testUser });
    const { router } = renderRoute("/login");
    await logIn();
    expect(await screen.findByRole("heading", { level: 2, name: "Dashboard" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(apiMock.calls("POST /api/v1/auth/login")[0]?.body).toEqual({
      username: "kari",
      password: "a long password",
    });
  });

  it("shows the app's version", async () => {
    renderRoute("/login");
    expect(await screen.findByText(`Bucky BudgetR ${APP_VERSION} · dev`)).toBeInTheDocument();
  });

  it("says when the username or password is wrong", async () => {
    apiMock.on(
      "POST /api/v1/auth/login",
      problem(401, "invalid_credentials", "Wrong username or password."),
    );
    renderRoute("/login");
    await logIn();
    expect(await screen.findByText("Wrong username or password.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/)).toHaveValue("");
    expect(screen.getByLabelText(/Username/)).toHaveValue("kari");
  });

  it("says how long to wait after too many attempts", async () => {
    apiMock.on(
      "POST /api/v1/auth/login",
      problem(429, "too_many_attempts", "Too many failed logins. Try again in 42 seconds."),
    );
    renderRoute("/login");
    await logIn();
    expect(await screen.findByText(/Try again in 42 seconds/)).toBeInTheDocument();
  });

  it("goes to the password change when one is required", async () => {
    apiMock.on("POST /api/v1/auth/login", { body: { ...testUser, must_change_password: true } });
    const { router } = renderRoute("/login?next=%2Faccounts");
    await logIn();
    expect(
      await screen.findByRole("heading", { name: "Choose a new password" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/change-password");
  });

  it("ignores a next that leaves the app", async () => {
    apiMock.on("POST /api/v1/auth/login", { body: testUser });
    const { router } = renderRoute("/login?next=%2F%2Fevil.example");
    await logIn();
    await screen.findByRole("heading", { level: 2, name: "Dashboard" });
    expect(router.state.location.pathname).toBe("/");
  });

  it("sends a logged-in user on", async () => {
    apiMock.on("GET /api/v1/me", { body: testUser });
    const { router } = renderRoute("/login");
    await screen.findByRole("heading", { level: 2, name: "Dashboard" });
    expect(router.state.location.pathname).toBe("/");
  });
});
