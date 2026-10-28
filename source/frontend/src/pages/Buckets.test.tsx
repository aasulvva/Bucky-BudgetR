import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { addDays, cycleRange, startAtFor, today } from "@/lib/cycles";
import { formatMoney } from "@/lib/money";
import { apiMock, testUser } from "@/test/api";
import { account, bucket, bucketFigures, cycle, transaction } from "@/test/fixtures";
import { renderRoute } from "@/test/render";
import { viewport } from "@/test/setup";

/** An amount as Testing Library reads it, with plain spaces. */
const m = (amount: string) => formatMoney(amount, "NOK").replace(/\s/g, " ");
/** An amount in an accessible name, which keeps the no-break spaces. */
const name = (amount: string) => formatMoney(amount, "NOK");

const main = account({
  id: "1234",
  name: "Main account",
  balance: "1500.00",
  unallocated: "0.00",
});
const buffer = account({
  id: "2345",
  name: "Buffer account",
  balance: "900.00",
  unallocated: "900.00",
});
const empty = account({ id: "3456", name: "Empty account" });
const base = { source_account_id: main.id };

const groceries = bucket({
  ...base,
  id: "1000000001",
  name: "Groceries",
  refill_amount: "4000.00",
  capacity: "4000.00",
  target_funds: "1000.00",
  current_available_funds: "650.00",
});
const rent = bucket({
  ...base,
  id: "1000000002",
  name: "Rent",
  priority: true,
  refill_amount: "800.00",
  capacity: "800.00",
  target_funds: "800.00",
  current_available_funds: "800.00",
  refilled: true,
});
const hobby = bucket({
  ...base,
  id: "1000000003",
  name: "Hobby",
  refill_mode: "manual",
  refill_amount: "1000.00",
  capacity: "1000.00",
  target_funds: "300.00",
  current_available_funds: "100.00",
});
const car = bucket({
  id: "1000000004",
  name: "Car",
  source_account_id: buffer.id,
  keep_funds: true,
  refill_amount: "500.00",
  capacity: "2500.00",
});

beforeEach(() => {
  viewport.width = 1280;
  apiMock.on("GET /api/v1/accounts", { body: [buffer, empty, main] });
  apiMock.on("GET /api/v1/buckets", { body: [car, groceries, hobby, rent] });
  apiMock.on("GET /api/v1/cycles/100001000001/bucket-figures", {
    body: [
      bucketFigures({
        bucket_id: groceries.id,
        start: "500.00",
        refills: "3500.00",
        budget: "4000.00",
        used: "3000.00",
        left: "1000.00",
      }),
      bucketFigures({ bucket_id: rent.id, refills: "800.00", budget: "800.00", left: "800.00" }),
    ],
  });
});

describe("Buckets", () => {
  it("groups the buckets by account, with the cycle's figures", async () => {
    renderRoute("/buckets");
    const section = within(await screen.findByRole("region", { name: "Main account" }));
    expect(section.getByText(m("2100.00"))).toBeInTheDocument(); // Left in buckets.
    expect(section.getByText(m("600.00"))).toBeInTheDocument(); // Short.
    expect(screen.queryByRole("region", { name: "Empty account" })).not.toBeInTheDocument();

    const row = within((await section.findByText("Groceries")).closest("tr") as HTMLElement);
    expect(await row.findByText(`${m("3000.00")} of ${m("4000.00")}`)).toBeInTheDocument();
    expect(row.getByText("75%")).toBeInTheDocument();
    // The breakdown, its parts but the start linking to the transactions.
    const breakdown = row.getByText(`Start ${m("500.00")}`).parentElement;
    expect(breakdown).toHaveTextContent(`Start ${m("500.00")} + refill ${m("3500.00")}`);
    expect(
      row.getByRole("button", { name: `refill ${name("3500.00")}: the transactions in Groceries` }),
    ).toBeInTheDocument();
    // Left is what the account backs; TF is struck through while it's short.
    expect(row.getByText(m("650.00"))).toBeInTheDocument();
    expect(row.getByText(m("1000.00"), { selector: "del" })).toBeInTheDocument();
    expect(
      row.getByRole("progressbar", { name: `Covered ${name("650.00")} of ${name("1000.00")}` }),
    ).toBeInTheDocument();
    expect(row.getByText(`${m("350.00")} not covered`)).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Covered" })).not.toBeInTheDocument();
    expect(row.getByText("Auto · not refilled")).toBeInTheDocument();
    const rentRow = within(section.getByText("Rent").closest("tr") as HTMLElement);
    expect(rentRow.getByText("Auto · refilled")).toBeInTheDocument();
    expect(rentRow.getByText("Fully covered")).toBeInTheDocument();
    expect(rentRow.queryByRole("progressbar", { name: /Covered/ })).not.toBeInTheDocument();
    expect(row.getByRole("link", { name: "Groceries" })).toHaveAttribute(
      "href",
      "/transactions?bucket_id=1000000001",
    );
    expect(row.getByRole("link", { name: "Bucket setup for Groceries" })).toHaveAttribute(
      "href",
      "/buckets/setup?edit=1000000001",
    );

    const other = within(screen.getByRole("region", { name: "Buffer account" }));
    expect(other.getAllByText(m("900.00"))).toHaveLength(2); // Balance and unallocated.
    expect(other.getByText("Auto · not refilled · keeps funds")).toBeInTheDocument();
  });

  it("warns about buckets that aren't covered, in red for priority ones", async () => {
    apiMock.on("GET /api/v1/buckets", {
      body: [groceries, { ...rent, current_available_funds: "500.00" }],
    });
    renderRoute("/buckets");
    expect(await screen.findByRole("img", { name: "Not fully covered" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Priority bucket not fully covered" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/even priority buckets aren't fully covered/)).toBeInTheDocument();
  });

  it("shows an overspent bucket's negative TF, in red", async () => {
    apiMock.on("GET /api/v1/buckets", {
      body: [{ ...groceries, target_funds: "-150.00", current_available_funds: "0.00" }],
    });
    renderRoute("/buckets");
    const row = within((await screen.findByText("Groceries")).closest("tr") as HTMLElement);
    expect(row.getByRole("img", { name: "Overspent" })).toBeInTheDocument();
    expect(row.getByText(m("-150.00"))).toBeInTheDocument();
    expect(row.getByText("Overspent")).toBeInTheDocument();
    expect(row.queryByText(/not covered/)).not.toBeInTheDocument();
  });

  it("refills a manual bucket", async () => {
    apiMock.on("POST /api/v1/buckets/1000000003/refill", { body: { ...hobby, refilled: true } });
    renderRoute("/buckets");
    // Only manual buckets that aren't refilled get the button.
    expect(screen.queryByRole("button", { name: "Refill Rent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refill Groceries" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Refill Hobby" }));
    expect(await screen.findByText(`Hobby refilled (+${m("700.00")}).`)).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/buckets/1000000003/refill")).toHaveLength(1);
  });

  it("reallocates an underfunded account by hand", async () => {
    apiMock.on("POST /api/v1/accounts/1234/reallocate", { body: main });
    renderRoute("/buckets");
    // Only underfunded accounts get the button.
    expect(
      screen.queryByRole("button", { name: "Reallocate Buffer account" }),
    ).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Reallocate Main account" }));
    expect(await screen.findByText("Main account reallocated.")).toBeInTheDocument();
    expect(apiMock.calls("POST /api/v1/accounts/1234/reallocate")).toHaveLength(1);
  });

  it("switches to the grid and remembers it", async () => {
    renderRoute("/buckets");
    await userEvent.click(await screen.findByRole("radio", { name: "Grid view" }));
    const card = within(await screen.findByRole("article", { name: "Groceries" }));
    expect(await card.findByText(`Used ${m("3000.00")} of ${m("4000.00")}`)).toBeInTheDocument();
    expect(
      card.getByRole("progressbar", { name: `Covered ${name("650.00")} of ${name("1000.00")}` }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(localStorage.getItem("bucky.bucketsView")).toBe("grid");
  });

  it("shows cards with a full-width refill on mobile", async () => {
    viewport.width = 390;
    renderRoute("/buckets");
    const card = within(await screen.findByRole("article", { name: "Hobby" }));
    expect(card.getByRole("button", { name: "Refill Hobby" })).toHaveTextContent(
      `Refill (+${m("700.00")})`,
    );
    expect(screen.queryByRole("radio", { name: "Grid view" })).not.toBeInTheDocument();
  });

  it("has no figures or refills without an active cycle", async () => {
    apiMock.on("GET /api/v1/cycles/active", { body: { active: null, next: null } });
    renderRoute("/buckets");
    expect(await screen.findAllByText("No active cycle")).not.toHaveLength(0);
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refill Hobby" })).not.toBeInTheDocument();
    expect(apiMock.requests.some((r) => r.path.endsWith("/bucket-figures"))).toBe(false);
  });

  it("points to Bucket setup when there are no buckets", async () => {
    apiMock.on("GET /api/v1/buckets", { body: [] });
    renderRoute("/buckets");
    expect(await screen.findByRole("link", { name: "Create one in Bucket setup" })).toHaveAttribute(
      "href",
      "/buckets/setup",
    );
  });

  it("speaks nynorsk", async () => {
    apiMock.on("GET /api/v1/me", {
      body: { ...testUser, preferences: { ...testUser.preferences, language: "nn" } },
    });
    renderRoute("/buckets");
    expect(await screen.findByRole("heading", { name: "Bøtter", level: 2 })).toBeInTheDocument();
    expect(await screen.findAllByRole("columnheader", { name: "Bøtte" })).toHaveLength(2);
    expect(screen.getAllByRole("img", { name: "Ikkje fullt dekt" })).toHaveLength(2);
  });
});

describe("a bucket's transactions", () => {
  const active = "100001000001";
  const ref = transaction({
    id: "20260101000001",
    type: "REF",
    created_by: null,
    bank_lines: [],
    bucket_lines: [{ bucket_id: groceries.id, cycle_id: active, amount: "3500.00" }],
  });
  const exp = transaction({
    id: "20260101000002",
    counterparty: "Rema 1000",
    bank_lines: [{ account_id: main.id, amount: "-3000.00" }],
    bucket_lines: [{ bucket_id: groceries.id, cycle_id: active, amount: "-3000.00" }],
  });
  const previous = cycle({
    id: "100001000000",
    state: "finished",
    start_at: startAtFor(addDays(today(), -40)),
    end_at: startAtFor(addDays(today(), -10)),
  });

  beforeEach(() => {
    apiMock.on("GET /api/v1/transactions", (req) => ({
      body: {
        items: req.query.get("cycle_id") === active ? [exp, ref] : [],
        next_cursor: null,
      },
    }));
  });

  it("lists the cycle's lines with what's left after each", async () => {
    renderRoute("/buckets");
    await userEvent.click(await screen.findByRole("button", { name: "Transactions in Groceries" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Groceries: transactions" }));
    // Groceries' account backs 650 of its 1 000.
    expect(
      await dialog.findByText(
        `The account only covers ${m("650.00")} of the ${m("1000.00")} right now, so Buckets shows ${m("650.00")} left.`,
      ),
    ).toBeInTheDocument();
    const rows = within(dialog.getByRole("list", { name: "Transactions" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((r) => r.textContent.replace(/\s/g, " "))).toEqual([
      expect.stringMatching(new RegExp(`^Rema 1000Expense.*Left ${m("1000.00")}$`)),
      expect.stringMatching(new RegExp(`^RefillRefill.*Left ${m("4000.00")}$`)),
      `At the start of the cycle${m("500.00")}`,
    ]);
    const query = apiMock.calls("GET /api/v1/transactions")[0]?.query;
    expect(query?.get("bucket_id")).toBe(groceries.id);
    expect(query?.get("cycle_id")).toBe(active);
    expect(query?.getAll("type")).toHaveLength(10);
    // A row opens it on the Transactions screen.
    expect(dialog.getByRole("link", { name: /Rema 1000/ })).toHaveAttribute(
      "href",
      `/transactions?bucket_id=${groceries.id}&cycle_id=${active}&system=1&open=${exp.id}`,
    );

    await userEvent.click(dialog.getByRole("combobox", { name: "Show" }));
    await userEvent.click(await screen.findByRole("option", { name: "Bucket transactions only" }));
    expect(dialog.queryByRole("link", { name: /Rema 1000/ })).not.toBeInTheDocument();
    expect(dialog.getByRole("link", { name: /Refill/ })).toBeInTheDocument();
  });

  it("opens from a part of the breakdown, showing that kind", async () => {
    renderRoute("/buckets");
    await userEvent.click(
      await screen.findByRole("button", {
        name: `refill ${name("3500.00")}: the transactions in Groceries`,
      }),
    );
    const dialog = within(await screen.findByRole("dialog", { name: "Groceries: transactions" }));
    expect(dialog.getByRole("combobox", { name: "Show" })).toHaveValue("Refill");
    expect(await dialog.findByRole("link", { name: /Refill/ })).toBeInTheDocument();
    expect(dialog.queryByRole("link", { name: /Rema 1000/ })).not.toBeInTheDocument();
  });

  it("shows an earlier cycle", async () => {
    apiMock.on("GET /api/v1/cycles", { body: [previous, cycle()] });
    apiMock.on(`GET /api/v1/cycles/${previous.id}/bucket-figures`, {
      // Without Keep funds: it started and ended at 0.
      body: [bucketFigures({ bucket_id: groceries.id })],
    });
    renderRoute("/buckets");
    await userEvent.click(await screen.findByRole("button", { name: "Transactions in Groceries" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Groceries: transactions" }));
    await userEvent.click(dialog.getByRole("combobox", { name: "Cycle" }));
    await userEvent.click(await screen.findByRole("option", { name: cycleRange(previous) }));
    expect(await dialog.findByText("Nothing in this cycle.")).toBeInTheDocument();
    // No start row at 0, and no coverage note outside the active cycle.
    expect(dialog.queryByText("At the start of the cycle")).not.toBeInTheDocument();
    expect(dialog.queryByText(/The account only covers/)).not.toBeInTheDocument();
    expect(apiMock.calls("GET /api/v1/transactions").at(-1)?.query.get("cycle_id")).toBe(
      previous.id,
    );
  });
});
