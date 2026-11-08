import i18n from "@/i18n";
import { transaction } from "@/test/fixtures";

import {
  defaultRepeat,
  fromTransaction,
  previewBody,
  repeatErrors,
  repeatFromSchedule,
  repeatSentence,
  scheduleBody,
  startsByNow,
  toInput,
  wallTime,
  type RepeatValues,
  type Schedule,
} from "./schedules";

// The tests run in America/Los_Angeles (vite.config.ts).
const LA = "America/Los_Angeles";
const en = i18n.getFixedT("en");
const nb = i18n.getFixedT("nb");

const rent: Schedule = {
  id: "1234560001",
  name: "Rent",
  transaction: { type: "EXP", account_id: "1234", amount: "9000.00", counterparty: "Landlord" },
  mode: "approve",
  due_days: 7,
  start_date: "2026-08-25",
  time: "08:00",
  time_zone: LA,
  frequency: "month",
  every: 1,
  end_count: null,
  end_date: null,
  paused: false,
  next_index: 3,
  next_at: "2026-11-25T16:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

describe("repeatSentence", () => {
  const say = (change: Partial<Schedule>, t = en, language = "en") =>
    repeatSentence({ ...rent, ...change }, t, language, "en-GB");

  it("puts each frequency in words, in English", () => {
    expect(say({})).toBe("Every month on the 25th at 08:00");
    expect(say({ start_date: "2026-08-01", every: 2 })).toBe("Every 2 months on the 1st at 08:00");
    expect(say({ start_date: "2026-08-22" })).toBe("Every month on the 22nd at 08:00");
    expect(say({ start_date: "2026-08-23" })).toBe("Every month on the 23rd at 08:00");
    expect(say({ start_date: "2026-08-11" })).toBe("Every month on the 11th at 08:00");
    expect(say({ frequency: "day" })).toBe("Every day at 08:00");
    expect(say({ frequency: "day", every: 3 })).toBe("Every 3 days at 08:00");
    // 25 August 2026 is a Tuesday.
    expect(say({ frequency: "week", every: 2 })).toBe("Every 2 weeks on Tuesday at 08:00");
    expect(say({ frequency: "year" })).toBe("Every year on 25 August at 08:00");
    expect(say({ frequency: "once" })).toBe("Once on 25 Aug 2026 at 08:00");
  });

  it("adds the end", () => {
    expect(say({ end_count: 3 })).toBe("Every month on the 25th at 08:00 · 3 times");
    expect(say({ end_count: 1 })).toBe("Every month on the 25th at 08:00 · once");
    expect(say({ end_date: "2027-01-31" })).toBe(
      "Every month on the 25th at 08:00 · until 31 Jan 2027",
    );
  });

  it("speaks Norwegian", () => {
    expect(say({}, nb, "nb")).toBe("Hver måned den 25. kl. 08:00");
    expect(say({ frequency: "week" }, nb, "nb")).toBe("Hver uke på tirsdag kl. 08:00");
    expect(say({ frequency: "day", every: 3, end_count: 4 }, nb, "nb")).toBe(
      "Hver 3. dag kl. 08:00 · 4 ganger",
    );
  });

  it("names a time zone that isn't the browser's", () => {
    expect(say({ time_zone: "Europe/Oslo" })).toBe(
      "Every month on the 25th at 08:00 (Europe/Oslo)",
    );
  });
});

describe("the form's values", () => {
  it("round-trips a schedule", () => {
    const r = repeatFromSchedule(rent);
    expect(r).toMatchObject({ startDate: "2026-08-25", time: "08:00", ends: "never", dueDays: 7 });
    expect(scheduleBody(r, rent.transaction)).toEqual(toInput(rent));
    const after = repeatFromSchedule({ ...rent, end_count: 4 });
    expect(after.ends).toBe("after");
    expect(scheduleBody(after, rent.transaction)).toMatchObject({ end_count: 4 });
    expect(scheduleBody({ ...after, ends: "never" }, rent.transaction)).not.toHaveProperty(
      "end_count",
    );
  });

  it("pauses a schedule as a full replacement", () => {
    expect(toInput(rent, { paused: true })).toEqual({
      name: "Rent",
      transaction: rent.transaction,
      mode: "approve",
      due_days: 7,
      start_date: "2026-08-25",
      time: "08:00",
      time_zone: LA,
      frequency: "month",
      every: 1,
      paused: true,
    });
  });

  it("checks the repeat", () => {
    const r = defaultRepeat(new Date("2026-11-08T18:30:00Z"), LA);
    expect(r).toMatchObject({ startDate: "2026-11-08", time: "10:30", frequency: "month" });
    expect(repeatErrors(r, en)).toEqual({});
    const bad: RepeatValues = {
      ...r,
      every: 0,
      ends: "on",
      endDate: "2026-11-01",
      mode: "approve",
      dueDays: 61,
      time: "24:00",
    };
    expect(Object.keys(repeatErrors(bad, en)).sort()).toEqual([
      "dueDays",
      "endDate",
      "every",
      "time",
    ]);
    expect(previewBody(bad)).toBeNull();
    expect(previewBody(r)).toEqual({
      start_date: "2026-11-08",
      time: "10:30",
      time_zone: LA,
      frequency: "month",
      every: 1,
      count: 5,
    });
    // Once ignores the repeat and the end.
    expect(previewBody({ ...bad, time: "10:30", frequency: "once" })).toMatchObject({ every: 1 });
  });

  it("knows when the first time is now or past", () => {
    const r = defaultRepeat(new Date("2026-11-08T18:30:00Z"), LA);
    expect(startsByNow(r, new Date("2026-11-08T18:30:30Z"))).toBe(true);
    expect(startsByNow(r, new Date("2026-11-08T18:29:00Z"))).toBe(false);
  });

  it("makes a transfer recurring from its time", () => {
    const tx = transaction({
      id: "2026102300000001",
      type: "TRF",
      at: "2026-10-23T06:15:00Z",
      bank_lines: [
        { account_id: "1234", amount: "-2000.00" },
        { account_id: "2345", amount: "2000.00" },
      ],
    });
    const { values, repeat } = fromTransaction(tx, LA);
    expect(values).toMatchObject({ amount: "2000.00", accountId: "1234", toAccountId: "2345" });
    expect(repeat).toMatchObject({ startDate: "2026-10-22", time: "23:15", frequency: "month" });
  });

  it("reads wall time in a zone", () => {
    expect(wallTime("2026-03-29T00:30:00Z", "Europe/Oslo")).toEqual({
      date: "2026-03-29",
      time: "01:30",
    });
    expect(wallTime("2026-03-29T01:30:00Z", "Europe/Oslo")).toEqual({
      date: "2026-03-29",
      time: "03:30",
    });
  });
});
