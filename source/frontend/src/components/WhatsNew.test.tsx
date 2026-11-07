import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Preferences } from "@/app/session";
import { APP_VERSION, CHANGELOG, entryTitle, isFeatureUpdate } from "@/lib/changelog";
import { apiMock, testUser } from "@/test/api";
import { renderRoute } from "@/test/render";

const [newest] = CHANGELOG;
// The newest version of an earlier feature: from it, the app's version pops
// up, whether that's a feature version or a patch of one.
const previous = CHANGELOG.find((e) => isFeatureUpdate(e.version, APP_VERSION));
if (!newest || !previous) throw new Error("the tests need an earlier feature version");

/** Signs in a user with these What's New preferences. */
function withPreferences(prefs: Preferences) {
  apiMock.on("GET /api/v1/me", {
    body: { ...testUser, preferences: { ...testUser.preferences, ...prefs } },
  });
  apiMock.on("PATCH /api/v1/me/preferences", (req) => ({
    body: { ...testUser.preferences, ...prefs, ...(req.body as object) },
  }));
}

async function findPopup() {
  return screen.findByRole("dialog", { name: "What's New" });
}

describe("What's New popup", () => {
  it("shows what changed since the last version seen, and saves it as seen", async () => {
    withPreferences({ whats_new_seen: previous.version });
    renderRoute("/");
    const popup = await findPopup();
    expect(within(popup).getByText(`Bucky BudgetR has been updated to ${APP_VERSION}.`));
    expect(
      within(popup).getByRole("heading", { name: entryTitle(newest, "en") }),
    ).toBeInTheDocument();
    expect(
      within(popup).queryByRole("heading", { name: entryTitle(previous, "en") }),
    ).not.toBeInTheDocument();

    await userEvent.click(within(popup).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences")).toHaveLength(1);
    });
    expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
      whats_new_seen: APP_VERSION,
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("can be turned off", async () => {
    withPreferences({ whats_new_seen: null });
    renderRoute("/");
    const popup = await findPopup();
    await userEvent.click(within(popup).getByLabelText("Don't show this after updates"));
    await userEvent.click(within(popup).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(apiMock.calls("PATCH /api/v1/me/preferences")[0]?.body).toEqual({
        whats_new_seen: APP_VERSION,
        whats_new_popup: false,
      });
    });
  });

  it("stays closed when turned off, or after a patch only", async () => {
    withPreferences({ whats_new_seen: previous.version, whats_new_popup: false });
    const { unmount } = renderRoute("/");
    expect(await screen.findByRole("heading", { level: 2, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();

    // Seen this feature version (its patches are compared in lib/changelog.test.ts).
    const [major, feature] = APP_VERSION.slice(1).split(".");
    withPreferences({ whats_new_seen: `v${major}.${feature}.00` });
    renderRoute("/");
    expect(await screen.findByRole("heading", { level: 2, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is in the app's language", async () => {
    withPreferences({ whats_new_seen: previous.version, language: "nb" });
    renderRoute("/");
    const popup = await screen.findByRole("dialog", { name: "Nytt i appen" });
    expect(
      within(popup).getByRole("heading", { name: entryTitle(newest, "nb") }),
    ).toBeInTheDocument();
    expect(within(popup).getByText(newest.changes.nb[0] ?? "")).toBeInTheDocument();
  });
});
