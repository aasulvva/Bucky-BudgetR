import { useQuery } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApiError } from "@/api/errors";
import { renderWithProviders } from "@/test/render";

import { QueryState } from "./QueryState";

function Status({ fetch }: { fetch: () => Promise<string> }) {
  const query = useQuery({ queryKey: ["status"], queryFn: fetch });
  return <QueryState query={query}>{(data) => <p>status: {data}</p>}</QueryState>;
}

describe("QueryState", () => {
  it("shows the data once loaded", async () => {
    renderWithProviders(<Status fetch={() => Promise.resolve("ok")} />);
    expect(await screen.findByText("status: ok")).toBeInTheDocument();
  });

  it("shows the problem with its request ID, and retries", async () => {
    const fetch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new ApiError({
          type: "about:blank",
          title: "Service Unavailable",
          status: 503,
          detail: "The database is not reachable.",
          request_id: "REQ123",
        }),
      )
      .mockResolvedValueOnce("ok");
    renderWithProviders(<Status fetch={fetch} />);

    expect(await screen.findByText("Service Unavailable")).toBeInTheDocument();
    expect(screen.getByText("The database is not reachable.")).toBeInTheDocument();
    expect(screen.getByText("REQ123")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("status: ok")).toBeInTheDocument();
  });
});
