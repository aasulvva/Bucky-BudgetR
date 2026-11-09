import { screen } from "@testing-library/react";

import { ApiError } from "@/api/errors";
import { apiMock, testUser } from "@/test/api";
import { renderRoute, renderWithProviders } from "@/test/render";

import { ErrorAlert } from "./ErrorAlert";

const error = new ApiError({
  type: "about:blank",
  title: "Internal error",
  status: 500,
  code: "internal_error",
  request_id: "REF123",
});

describe("ErrorAlert", () => {
  it("shows the request ID as a reference to copy and pass on (#93)", () => {
    renderWithProviders(<ErrorAlert error={error} />);
    expect(screen.getByText("REF123")).toBeInTheDocument();
    expect(screen.getByText(/Reference/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the reference" })).toBeInTheDocument();
    expect(screen.getByText("Quote it when you report the problem.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open in Logs" })).not.toBeInTheDocument();
  });

  it("links admins to the request's log entries", async () => {
    apiMock.on("GET /api/v1/me", { body: { ...testUser, admin: true } });
    apiMock.on("GET /api/v1/accounts", {
      status: 500,
      body: { ...error.problem, title: "Internal error" },
    });
    renderRoute("/accounts");
    expect(await screen.findByRole("link", { name: "Open in Logs" })).toHaveAttribute(
      "href",
      "/admin/logs?request=REF123",
    );
  });
});
