import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { apiMock, problem, testUser } from "@/test/api";
import { renderRoute } from "@/test/render";

const token = "xC9v3gInhD6Z6seIVchYN79dotG3LzQfWKKhmZscPKc";

beforeEach(() => {
  // Nobody is logged in yet.
  apiMock.on("GET /api/v1/me", problem(401, "unauthenticated", "Log in first."));
});

async function choose(password: string) {
  await userEvent.type(await screen.findByLabelText(/^New password/), password);
  await userEvent.type(screen.getByLabelText(/^Repeat the new password/), password);
  await userEvent.click(screen.getByRole("button", { name: "Save and log in" }));
}

describe("SetPassword", () => {
  it("sets the password with a setup link and logs in", async () => {
    apiMock.on("POST /api/v1/auth/password-link", {
      body: { username: "kari", purpose: "setup", expires_at: "2026-10-27T22:00:00Z" },
    });
    apiMock.on("POST /api/v1/auth/password-link/use", { body: testUser });
    renderRoute(`/set-password#${token}`);

    expect(await screen.findByRole("heading", { name: "Welcome, kari" })).toBeVisible();
    expect(screen.queryByLabelText(/Current password/)).not.toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/auth/password-link")[0]?.body).toEqual({ token });

    await choose("kari's own password");
    expect(await screen.findByRole("heading", { level: 2, name: "Dashboard" })).toBeVisible();
    expect(apiMock.calls("POST /api/v1/auth/password-link/use")[0]?.body).toEqual({
      token,
      new_password: "kari's own password",
    });
  });

  it("greets a reset", async () => {
    apiMock.on("POST /api/v1/auth/password-link", {
      body: { username: "kari", purpose: "reset", expires_at: "2026-10-27T22:00:00Z" },
    });
    renderRoute(`/set-password#${token}`);
    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeVisible();
    expect(screen.getByText(/Hi, kari/)).toBeInTheDocument();
  });

  it("says when the link doesn't work", async () => {
    apiMock.on("POST /api/v1/auth/password-link", problem(404, "invalid_link", "Doesn't work."));
    renderRoute(`/set-password#${token}`);
    expect(await screen.findByRole("heading", { name: "This link doesn't work" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to login" })).toHaveAttribute("href", "/login");
  });

  it("needs a token", async () => {
    renderRoute("/set-password");
    expect(await screen.findByRole("heading", { name: "This link doesn't work" })).toBeVisible();
    expect(apiMock.calls("POST /api/v1/auth/password-link")).toHaveLength(0);
  });

  it("shows a link that stopped working meanwhile", async () => {
    apiMock.on("POST /api/v1/auth/password-link", {
      body: { username: "kari", purpose: "setup", expires_at: "2026-10-27T22:00:00Z" },
    });
    apiMock.on(
      "POST /api/v1/auth/password-link/use",
      problem(404, "invalid_link", "Doesn't work."),
    );
    renderRoute(`/set-password#${token}`);
    await choose("kari's own password");
    expect(
      await screen.findByText("This link doesn't work. Ask an admin for a new one."),
    ).toBeInTheDocument();
  });
});
