import {
  ActionIcon,
  Anchor,
  Autocomplete,
  Box,
  Button,
  Card,
  Checkbox,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
  useMantineTheme,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router";

import { useRefreshMoney, type Account, type Bucket } from "@/api/accounts";
import { api } from "@/api/client";
import { useCurrentCycles, type Cycle } from "@/api/cycles";
import { unwrap } from "@/api/errors";
import { useApprove, useSaveSchedule } from "@/api/schedules";
import {
  useCounterparties,
  useTags,
  type NewTransactionType,
  type Transaction,
  type TransactionCorrection,
  type TransactionCreate,
  type TransactionType,
} from "@/api/transactions";
import { useSession } from "@/app/session";
import { AmountInput } from "@/components/AmountInput";
import { DateTimeInput } from "@/components/DateTimeInput";
import { ErrorAlert } from "@/components/ErrorAlert";
import { RecordConfirm, type RecordAsk } from "@/components/transactions/RecordConfirm";
import { ModeFields, RepeatFields } from "@/components/schedules/RepeatFields";
import { bsuAsk, isLockedBsu } from "@/lib/bsu";
import { limitAsk } from "@/lib/cards";
import { now } from "@/lib/clock";
import { browserTimeZone } from "@/lib/cycleRule";
import { cycleRange, isOverdue } from "@/lib/cycles";
import { formatDateTime } from "@/lib/dates";
import { compareAmounts, formatMoney, subtractAmounts } from "@/lib/money";
import {
  bucketTotals,
  correctionBody,
  editState,
  followAmount,
  fromLastTime,
  initialAccount,
  insideCycle,
  cleanDescription,
  newLine,
  prefillFor,
  ruleMatches,
  waitingOnIncome,
  type SplitLine,
} from "@/lib/transactionForm";
import { bucketLinesLocked, isCorrectableType, isSavingsTransfer } from "@/lib/transactionList";
import {
  approveDate,
  defaultRepeat,
  fromTransaction,
  isSchedulable,
  repeatErrors,
  repeatFromSchedule,
  scheduleBody,
  valuesFromSchedule,
  wallTime,
  type RepeatErrors,
  type Occurrence,
  type RepeatValues,
  type Schedule,
  type ScheduleTransaction,
} from "@/lib/schedules";

/** The last account a transaction was saved on, in this browser. */
const LAST_ACCOUNT_KEY = "bucky.lastAccount";

function lastAccount(): string | null {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

function rememberAccount(id: string) {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, id);
  } catch {
    // Not remembered; the next form starts without it.
  }
}

const TYPES: NewTransactionType[] = ["EXP", "INC", "TRF"];

interface Errors {
  amount?: string;
  account?: string;
  to?: string;
  at?: string;
  split?: string;
  /** Per row key. */
  lines?: Record<number, { bucket?: string; amount?: string }>;
}

/** A schedule form (#154): the transaction a schedule records, and when. */
export interface ScheduleOptions {
  /** The schedule being edited; otherwise a new one. */
  editing?: Schedule;
  /** Make recurring: a new schedule like this transaction. */
  from?: Transaction;
}

/** Edit and approve (#155): a queued one, recorded as edited. */
export interface ApproveOptions {
  occurrence: Occurrence;
  schedule: Schedule;
}

/**
 * The Create transaction form (spec §9). With `editing`, it corrects that
 * transaction instead: the type is fixed, the time stays the original one, and
 * only what changed is sent. Bucket lines outside the active cycle are shown
 * but locked.
 *
 * With `schedule`, it's a schedule's form instead: the same transaction, and
 * when it's recorded (RepeatFields). New transaction can also be set to
 * repeat: it's then saved as a schedule, recorded now when its first time is
 * now or past.
 *
 * With `approve`, it approves a queued scheduled transaction (#155): the
 * schedule's transaction, its type fixed, dated at its scheduled time when
 * the active cycle contains it, else now; it can't repeat or be later.
 */
export function TransactionForm({
  accounts,
  buckets,
  editing,
  schedule,
  approve,
}: {
  accounts: Account[];
  buckets: Bucket[];
  editing?: Transaction;
  schedule?: ScheduleOptions;
  approve?: ApproveOptions;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  const isDesktop = useMediaQuery(`(min-width: ${theme.breakpoints.sm})`, true);
  const navigate = useNavigate();
  const location = useLocation();
  const refresh = useRefreshMoney();
  const preferences = useSession().data?.preferences;
  const rules = preferences?.income_refill_rules ?? [];
  const zone = preferences?.time_zone ?? browserTimeZone();
  const scheduleMode = schedule !== undefined;
  const approving = approve !== undefined;
  const from = schedule?.from && isSchedulable(schedule.from) ? schedule.from : undefined;
  const active = useCurrentCycles().data?.active ?? null;
  const amountId = useId();

  const [start] = useState(() => {
    if (editing) return editState(editing);
    if (schedule?.editing) return valuesFromSchedule(schedule.editing);
    if (approve) return valuesFromSchedule(approve.schedule);
    if (from) return editState(from);
    return null;
  });
  const [newType, setType] = useState<NewTransactionType>(
    schedule?.editing?.transaction.type ??
      approve?.schedule.transaction.type ??
      from?.type ??
      "EXP",
  );
  const type: TransactionType = editing?.type ?? newType;
  const [amount, setAmount] = useState<string | null>(start?.amount ?? null);
  const [at, setAt] = useState<string | null>(() =>
    approve ? approveDate(approve.occurrence, active) : (editing?.at ?? null),
  );
  const [accountId, setAccountId] = useState(() =>
    start ? start.accountId : initialAccount(accounts, lastAccount()),
  );
  // When editing, a suggestion never moves the transaction.
  const [accountTouched, setAccountTouched] = useState(start !== null);
  const [toAccountId, setToAccountId] = useState<string | null>(start?.toAccountId ?? null);
  const [counterparty, setCounterparty] = useState(start?.counterparty ?? "");
  const [description, setDescription] = useState(start?.description ?? "");
  // On mobile the description is behind Add description, unless it has one.
  const [descriptionOpen, setDescriptionOpen] = useState(description !== "");
  const [tags, setTags] = useState<string[]>(start?.tags ?? []);
  const [lines, setLines] = useState<SplitLine[]>(start?.lines ?? []);
  // The rows as the user last set them, and the amount they were set for: a
  // new amount reshapes them from here (followAmount).
  const [base, setBase] = useState({ amount: start?.amount ?? null, lines: start?.lines ?? [] });
  const [refill, setRefill] = useState<boolean | null>(start?.triggersRefill ?? null);
  const [errors, setErrors] = useState<Errors>({});
  // The schedule: always on a schedule's form, a choice in New transaction.
  const [repeatOn, setRepeatOn] = useState(scheduleMode);
  const [repeat, setRepeat] = useState<RepeatValues>(() => {
    if (schedule?.editing) return repeatFromSchedule(schedule.editing);
    if (from) return fromTransaction(from, zone).repeat;
    return defaultRepeat(now(), zone);
  });
  const [repeatErrs, setRepeatErrs] = useState<RepeatErrors>({});
  // A new transaction set to happen later is saved as a schedule for then,
  // recorded once (or approved first).
  const future =
    !editing &&
    !scheduleMode &&
    !approving &&
    !repeatOn &&
    at !== null &&
    new Date(at).getTime() > now().getTime();
  const scheduled = repeatOn || future;
  // A new schedule's first time that's now or past is recorded at once, as
  // entered done, unless it's Make recurring's: that's the transaction itself.
  const recordFirst = repeatOn && !schedule?.editing && !schedule?.from;

  const balance = type === "OPB" || type === "BLA";
  const transfer = type === "TRF";
  const withBuckets = type === "INC" || type === "EXP";
  const locked = editing ? bucketLinesLocked(editing, active) : false;
  // A Done transfer (#231) keeps its amount and accounts: only its text changes.
  const heldTransfer = editing ? isSavingsTransfer(editing) : false;
  const account = accounts.find((a) => a.id === accountId);
  const currency = account?.currency;
  const own = buckets.filter((b) => b.source_account_id === accountId);
  const others = accounts.filter((a) => a.id !== accountId && a.currency === currency);
  const totals = bucketTotals(amount, lines);
  const inCycle = insideCycle(at, active);
  const waiting = type === "INC" && !editing ? waitingOnIncome(buckets, accountId) : [];
  const refillShown = type === "INC" && (inCycle || scheduled) && accountId !== null;
  const refillChecked = refill ?? (waiting.length > 0 || ruleMatches(rules, counterparty, amount));
  const money = (value: string) => formatMoney(value, currency);
  // What a BSU the money goes into may still take this year (#214); interest
  // isn't a deposit.
  const into =
    type === "INC" ? account : transfer ? accounts.find((a) => a.id === toAccountId) : undefined;
  const interest = tags.some((tag) => tag.trim().toLowerCase() === "interest");
  const bsuInto = into?.bsu && !into.bsu.locked && !interest ? into : undefined;
  const bsuHint = bsuInto?.bsu
    ? t("bsu.leftHintAccount", {
        name: bsuInto.name,
        amount: formatMoney(bsuInto.bsu.left_year, bsuInto.currency),
      })
    : null;
  const bsuHintOrange =
    bsuInto?.bsu !== undefined &&
    bsuInto.bsu !== null &&
    amount !== null &&
    compareAmounts(amount, bsuInto.bsu.left_year) > 0;
  // A credit card the money comes out of: what's available on it, orange
  // when the amount is more (#260); one paid to: what's owed on it.
  const cardFrom = (type === "EXP" || transfer) && account?.credit_card ? account : undefined;
  const cardTo = transfer ? accounts.find((a) => a.id === toAccountId && a.credit_card) : undefined;
  const cardHint = cardFrom?.credit_card
    ? t("cards.hintAccount", {
        name: cardFrom.name,
        amount: formatMoney(cardFrom.credit_card.available, cardFrom.currency),
        limit: formatMoney(cardFrom.credit_card.credit_limit, cardFrom.currency),
      })
    : cardTo?.credit_card
      ? t("cards.hintPayment", {
          name: cardTo.name,
          amount: formatMoney(cardTo.credit_card.owed, cardTo.currency),
        })
      : null;
  const cardHintOrange =
    cardFrom?.credit_card !== undefined &&
    cardFrom.credit_card !== null &&
    amount !== null &&
    compareAmounts(amount, cardFrom.credit_card.available) > 0;
  const correction = editing
    ? correctionBody(
        editing,
        {
          amount,
          accountId,
          toAccountId,
          counterparty,
          description,
          tags,
          lines,
          triggersRefill: refillChecked,
        },
        locked,
      )
    : null;

  const changeLines = (next: SplitLine[]) => {
    setLines(next);
    setBase({ amount, lines: next });
  };

  const changeAmount = (next: string | null) => {
    setAmount(next);
    // Locked lines can't change, so they don't follow.
    if (withBuckets && !locked) setLines(followAmount(base, next));
  };

  // A locked BSU takes nothing until it's set up (#214); one already chosen
  // stays, so the form shows it.
  const lockedOut = accounts.some((a) => isLockedBsu(a));
  const accountOptions = (list: Account[], keep: string | null) =>
    list
      .filter((a) => !isLockedBsu(a) || a.id === keep)
      .map((a) => ({
        value: a.id,
        label: t("newTransaction.accountOption", {
          name: a.name,
          balance: formatMoney(a.balance, a.currency),
        }),
      }));

  const changeAccount = (id: string) => {
    setAccountId(id);
    setAccountTouched(true);
    changeLines(
      lines.filter(
        (l) =>
          l.bucketId === null ||
          buckets.some((b) => b.id === l.bucketId && b.source_account_id === id),
      ),
    );
    if (toAccountId === id) setToAccountId(null);
  };

  const reset = () => {
    setAmount(null);
    setCounterparty("");
    setDescription("");
    setDescriptionOpen(false);
    setTags([]);
    setLines([]);
    setBase({ amount: null, lines: [] });
    setRefill(null);
    setErrors({});
    document.getElementById(amountId)?.focus();
  };

  const goBack = (fallback: string) => {
    if (location.key === "default") void navigate(fallback);
    else void navigate(-1);
  };

  const saveSchedule = useSaveSchedule(async (saved) => {
    let message: string = t("schedules.saved");
    if (!scheduleMode) {
      if (saved.next_index === 0) {
        message = t("newTransaction.scheduledFor", { date: formatDateTime(saved.next_at ?? "") });
      } else if (saved.next_at) {
        message = t("newTransaction.savedRepeating", { date: formatDateTime(saved.next_at) });
      } else {
        message = t("newTransaction.savedEnded");
      }
    }
    rememberAccount(saved.transaction.account_id);
    notifications.show({ color: "green", message });
    if (scheduleMode) await navigate("/transactions/scheduled");
    else goBack("/");
  });

  const changeRepeat = (change: Partial<RepeatValues>) => {
    setRepeat((r) => ({ ...r, ...change }));
  };

  /** A schedule recorded once, at `iso`. */
  const onceAt = (iso: string): RepeatValues => {
    const w = wallTime(iso, repeat.timeZone);
    return {
      ...repeat,
      startDate: w.date,
      time: w.time,
      frequency: "once",
      ends: "never",
      name: "",
    };
  };

  const toggleRepeat = (on: boolean) => {
    setRepeatOn(on);
    // It starts when the transaction was set to happen, or now.
    if (on) {
      const w = wallTime(at ?? now(), repeat.timeZone);
      changeRepeat({ startDate: w.date, time: w.time });
    }
  };

  const approveSave = useApprove(async () => {
    notifications.show({ color: "green", message: t("schedules.queue.approved", { count: 1 }) });
    await navigate("/transactions/scheduled");
  });

  const save = useMutation({
    mutationFn: ({ body }: { body: TransactionCreate; addAnother: boolean }) =>
      unwrap(api.POST("/api/v1/transactions", { body })),
    meta: { silentError: true },
    onSuccess: async (_, { body, addAnother }) => {
      rememberAccount(body.account_id);
      notifications.show({ color: "green", message: t(`newTransaction.saved.${body.type}`) });
      await refresh();
      if (addAnother) reset();
      else goBack("/");
    },
  });

  const correct = useMutation({
    mutationFn: (body: TransactionCorrection) =>
      unwrap(
        api.POST("/api/v1/transactions/{transactionId}/correction", {
          params: { path: { transactionId: editing?.id ?? "" } },
          body,
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (result) => {
      const moved = result.id !== editing?.id;
      notifications.show({
        color: "green",
        message: moved ? t("newTransaction.movedDone") : t("newTransaction.corrected"),
      });
      await refresh();
      goBack(`/transactions?open=${result.id}`);
    },
  });

  const validate = (): Errors => {
    const found: Errors = {};
    if (balance) {
      if (amount === null || compareAmounts(amount, "0") === 0) {
        found.amount = t("newTransaction.enterNonZero");
      }
    } else if (amount === null || compareAmounts(amount, "0") <= 0) {
      found.amount = t("newTransaction.enterAmount");
    }
    if (!accountId) found.account = t("common.chooseAccount");
    if (transfer && (!toAccountId || toAccountId === accountId)) {
      found.to = t("newTransaction.chooseOther");
    }
    if (withBuckets && lines.length > 0) {
      if (!locked) {
        const lineErrors: NonNullable<Errors["lines"]> = {};
        for (const l of lines) {
          const e = {
            bucket: l.bucketId ? undefined : t("newTransaction.chooseBucket"),
            amount:
              l.amount === null || compareAmounts(l.amount, "0") <= 0
                ? t("newTransaction.enterAmount")
                : undefined,
          };
          if (e.bucket ?? e.amount) lineErrors[l.key] = e;
        }
        if (Object.keys(lineErrors).length > 0) found.lines = lineErrors;
      }
      if (totals.over) {
        found.split = t("newTransaction.overBy", {
          amount: money(subtractAmounts("0", totals.notTied)),
        });
      }
      if (!editing && !scheduled && active && !inCycle) {
        found.at = t("newTransaction.outsideCycle", { range: cycleRange(active) });
      }
    }
    return found;
  };

  const submit = (addAnother: boolean) => {
    const found = validate();
    setErrors(found);
    const shape = future && at ? onceAt(at) : repeat;
    const foundRepeat = scheduled ? repeatErrors(shape, t) : {};
    setRepeatErrs(foundRepeat);
    if (
      Object.keys(found).length > 0 ||
      Object.keys(foundRepeat).length > 0 ||
      amount === null ||
      accountId === null
    ) {
      return;
    }
    if (editing) {
      if (correction) correct.mutate(correction);
      return;
    }
    if (balance) return; // Only edited, never created here.
    const common = {
      account_id: accountId,
      amount,
      // A schedule has its own times.
      ...(at && !scheduled ? { at } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(cleanDescription(description) ? { description: cleanDescription(description) } : {}),
    };
    const body: TransactionCreate = transfer
      ? { type: newType, ...common, to_account_id: toAccountId ?? "" }
      : {
          type: newType,
          ...common,
          ...(counterparty.trim() ? { counterparty: counterparty.trim() } : {}),
          ...(lines.length > 0
            ? {
                bucket_lines: lines.map((l) => ({
                  bucket_id: l.bucketId ?? "",
                  amount: l.amount ?? "",
                })),
              }
            : {}),
          ...(refillShown ? { triggers_refill: refillChecked } : {}),
        };
    if (scheduled) {
      const transaction: ScheduleTransaction = body;
      const input = scheduleBody(shape, transaction);
      if (!input) return;
      saveSchedule.mutate({
        ...(schedule?.editing ? { id: schedule.editing.id } : {}),
        body: input,
        recordFirst,
      });
      return;
    }
    if (approve) {
      approveSave.mutate({ id: approve.occurrence.id, body });
      return;
    }
    save.mutate({ body, addAnother });
  };

  const fields = (
    <Stack gap="md" style={{ flex: "1 1 360px", minWidth: 0 }}>
      <Stack gap={4}>
        <AmountInput
          id={amountId}
          label={t("newTransaction.amount")}
          currency={currency}
          value={amount}
          onChange={changeAmount}
          error={errors.amount}
          size={isDesktop ? "lg" : "xl"}
          styles={{ input: { fontWeight: 600 } }}
          autoFocus={!heldTransfer}
          disabled={heldTransfer}
        />
        <Text size="xs" c="dimmed">
          {heldTransfer
            ? t("newTransaction.savingsTransferHint")
            : t(`newTransaction.hints.${isCorrectableType(type) ? type : "EXP"}`)}
        </Text>
      </Stack>
      {editing ? (
        <DateTimeInput
          label={t("newTransaction.date")}
          description={t("newTransaction.dateFixed")}
          value={at}
          onChange={() => undefined}
          clearable={false}
          disabled
        />
      ) : repeatOn ? null : (
        <DateTimeInput
          label={t("newTransaction.date")}
          description={t("newTransaction.dateHint")}
          value={at}
          onChange={setAt}
          error={errors.at}
          // A later time schedules it; an approved one is recorded by now.
          {...(approving ? {} : { maxDate: undefined })}
          {...(!transfer && lines.length > 0 && active && !isOverdue(active)
            ? { minDate: new Date(active.start_at) }
            : {})}
        />
      )}
      {future && at && (
        <Card withBorder padding="sm" bg="var(--mantine-color-blue-light)">
          <Stack gap="sm">
            <Text size="sm">{t("newTransaction.futureNote", { date: formatDateTime(at) })}</Text>
            <ModeFields value={repeat} onChange={changeRepeat} errors={repeatErrs} />
          </Stack>
        </Card>
      )}
      {!editing && !scheduleMode && !approving && (
        <Switch
          label={t("newTransaction.repeat")}
          description={t("newTransaction.repeatHint")}
          checked={repeatOn}
          onChange={(e) => {
            toggleRepeat(e.currentTarget.checked);
          }}
        />
      )}
      <Select
        label={t(transfer ? "newTransaction.from" : "newTransaction.account")}
        data={accountOptions(accounts, accountId)}
        value={accountId}
        allowDeselect={false}
        onChange={(v) => {
          if (v) changeAccount(v);
        }}
        error={errors.account}
        disabled={balance || heldTransfer}
        description={
          editing && !balance && !heldTransfer ? t("newTransaction.moveHint") : undefined
        }
      />
      {transfer && (
        <Select
          label={t("newTransaction.to")}
          data={accountOptions(others, toAccountId)}
          value={toAccountId}
          onChange={setToAccountId}
          error={errors.to}
          description={
            accountId && others.length === 0 ? t("newTransaction.noOther", { currency }) : undefined
          }
          disabled={others.length === 0 || heldTransfer}
        />
      )}
      {bsuHint && (
        <Text size="xs" c={bsuHintOrange ? "var(--mantine-color-orange-text)" : "dimmed"} mt={-8}>
          {bsuHint}
        </Text>
      )}
      {cardHint && (
        <Text size="xs" c={cardHintOrange ? "var(--mantine-color-orange-text)" : "dimmed"} mt={-8}>
          {cardHint}
        </Text>
      )}
      {lockedOut && !balance && (
        <Text size="xs" c="dimmed" mt={-8}>
          {t("bsu.lockedOut")}
        </Text>
      )}
      {withBuckets && (
        <CounterpartyInput
          type={type === "INC" ? "INC" : "EXP"}
          value={counterparty}
          onChange={setCounterparty}
          onPick={(suggestion) => {
            const filled = fromLastTime(
              suggestion,
              {
                amount,
                accountId,
                accountTouched,
                tags,
                lines,
                bucketsAllowed: (active !== null || scheduled) && !locked,
              },
              accounts,
              buckets,
            );
            if (filled.accountId) setAccountId(filled.accountId);
            if (filled.tags) setTags(filled.tags);
            if (filled.lines) changeLines(filled.lines);
          }}
        />
      )}
      {balance && (
        <TextInput
          label={t("newTransaction.counterparty.other")}
          value={counterparty}
          maxLength={200}
          onChange={(e) => {
            setCounterparty(e.currentTarget.value);
          }}
        />
      )}
      {isDesktop || descriptionOpen ? (
        <Textarea
          label={t("newTransaction.description")}
          placeholder={t("newTransaction.descriptionPlaceholder")}
          autosize
          minRows={1}
          maxRows={6}
          maxLength={500}
          // Opened with Add description: straight to typing.
          autoFocus={!isDesktop && description === ""}
          value={description}
          onChange={(e) => {
            setDescription(e.currentTarget.value);
          }}
        />
      ) : (
        <Box>
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => {
              setDescriptionOpen(true);
            }}
          >
            {t("newTransaction.addDescription")}
          </Anchor>
        </Box>
      )}
      {refillShown && (
        <Card withBorder padding="sm" bg="var(--mantine-color-blue-light)">
          <Checkbox
            label={t("newTransaction.triggersRefill")}
            description={
              editing
                ? t("newTransaction.refillsEdit")
                : waiting.length > 0
                  ? t("newTransaction.refillsWaiting", {
                      names: waiting.map((b) => b.name).join(", "),
                    })
                  : t("newTransaction.refillsNone")
            }
            checked={refillChecked}
            onChange={(e) => {
              setRefill(e.currentTarget.checked);
            }}
          />
        </Card>
      )}
      <TagInput value={tags} onChange={setTags} />
    </Stack>
  );

  const error = save.error ?? correct.error ?? saveSchedule.error ?? approveSave.error;
  // A BSU over its limits, or money out of one (#214), and a credit card
  // past its limit (#260), ask first. Each answer is kept when the other
  // asks next.
  const askOf = (error: unknown): RecordAsk | undefined =>
    bsuAsk(error) ?? (limitAsk(error) ? "over_credit_limit" : undefined);
  const ask = askOf(save.error) ?? askOf(correct.error);
  const confirmed = (a: RecordAsk) =>
    a === "over_credit_limit" ? { limit_confirmed: true } : { bsu_confirmed: true };
  const confirmAsk = () => {
    const a = askOf(save.error);
    const c = askOf(correct.error);
    if (a && save.variables) {
      const v = save.variables;
      save.mutate({ ...v, body: { ...v.body, ...confirmed(a) } });
    } else if (c && correct.variables) {
      correct.mutate({ ...correct.variables, ...confirmed(c) });
    }
  };
  const saving = (addAnother: boolean) =>
    editing
      ? correct.isPending
      : approving
        ? approveSave.isPending
        : saveSchedule.isPending
          ? !addAnother
          : save.isPending && save.variables.addAnother === addAnother;
  const cancel = (
    <Button
      variant="default"
      onClick={() => {
        goBack(
          editing
            ? `/transactions?open=${editing.id}`
            : scheduleMode || approving
              ? "/transactions/scheduled"
              : "/",
        );
      }}
    >
      {t("common.cancel")}
    </Button>
  );

  return (
    <form
      noValidate
      aria-label={
        editing
          ? t("newTransaction.editForm")
          : approving
            ? t("schedules.queue.pageTitle")
            : scheduleMode
              ? t(schedule.editing ? "schedules.edit" : "schedules.new")
              : t("nav.items.newTransaction")
      }
      onSubmit={(e) => {
        e.preventDefault();
        submit(false);
      }}
    >
      {/* Not Card's overflow: hidden, which would make the card the save bar's
          scroll container and push the bar up over the last fields (#103). */}
      <Card withBorder padding={isDesktop ? "lg" : "md"} maw={960} style={{ overflow: "visible" }}>
        <Stack gap="lg">
          {!editing && !approving && (
            <SegmentedControl
              aria-label={t("newTransaction.type")}
              value={newType}
              onChange={(v) => {
                const next = TYPES.find((x) => x === v);
                if (next) setType(next);
              }}
              fullWidth={!isDesktop}
              style={isDesktop ? { alignSelf: "flex-start" } : undefined}
              data={[
                ...TYPES.map((x) => ({ value: x, label: t(`newTransaction.types.${x}`) })),
                ...(isDesktop
                  ? [{ value: "INP", label: t("newTransaction.types.INP"), disabled: true }]
                  : []),
              ]}
            />
          )}
          <Group align="flex-start" gap="xl" wrap="wrap">
            {fields}
            {withBuckets && (
              <BucketSplit
                account={account}
                own={own}
                all={buckets}
                active={active}
                amount={amount}
                lines={lines}
                onChange={changeLines}
                errors={errors}
                locked={locked}
                needsCycle={!scheduled}
              />
            )}
          </Group>
          {repeatOn && (
            <Box
              pt="md"
              maw={560}
              style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
            >
              <RepeatFields
                value={repeat}
                onChange={changeRepeat}
                errors={repeatErrs}
                editing={schedule?.editing !== undefined}
                recordFirst={recordFirst}
              />
            </Box>
          )}
          {ask ? (
            <RecordConfirm
              ask={ask}
              pending={save.isPending || correct.isPending}
              onConfirm={confirmAsk}
              onCancel={() => {
                save.reset();
                correct.reset();
              }}
            />
          ) : (
            error && <ErrorAlert error={error} />
          )}
          {isDesktop ? (
            <Group
              justify="flex-end"
              gap="xs"
              pt="sm"
              style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
            >
              {cancel}
              {!editing && !scheduled && !approving && (
                <Button
                  variant="outline"
                  loading={saving(true)}
                  onClick={() => {
                    submit(true);
                  }}
                >
                  {t("newTransaction.saveAnother")}
                </Button>
              )}
              <Button
                type="submit"
                disabled={editing && correction === null}
                loading={saving(false)}
              >
                {t(approving ? "schedules.queue.approve" : "newTransaction.save")}
              </Button>
            </Group>
          ) : (
            <Stack
              gap="xs"
              pos="sticky"
              py="sm"
              mx="-md"
              px="md"
              bg="var(--mantine-color-body)"
              style={{
                bottom: "var(--app-shell-footer-offset, 0px)",
                borderTop: "1px solid var(--mantine-color-default-border)",
                zIndex: 1,
              }}
            >
              {!editing && !scheduled && !approving && (
                <Button
                  variant="subtle"
                  loading={saving(true)}
                  onClick={() => {
                    submit(true);
                  }}
                >
                  {t("newTransaction.saveAnother")}
                </Button>
              )}
              <Button
                type="submit"
                size="lg"
                fullWidth
                disabled={editing && correction === null}
                loading={saving(false)}
              >
                {t(approving ? "schedules.queue.approve" : "newTransaction.save")}
              </Button>
            </Stack>
          )}
        </Stack>
      </Card>
    </form>
  );
}

function CounterpartyInput({
  type,
  value,
  onChange,
  onPick,
}: {
  type: "INC" | "EXP";
  value: string;
  onChange: (value: string) => void;
  onPick: (suggestion: NonNullable<ReturnType<typeof useCounterparties>["data"]>[number]) => void;
}) {
  const { t } = useTranslation();
  const suggestions = useCounterparties(type, value);
  const list = suggestions.data ?? [];
  return (
    <Autocomplete
      label={t(`newTransaction.counterparty.${type}`)}
      placeholder={t("newTransaction.counterpartyPlaceholder")}
      value={value}
      maxLength={200}
      onChange={onChange}
      data={list.map((s) => s.counterparty)}
      // The server already filtered by what's typed.
      filter={({ options }) => options}
      onOptionSubmit={(picked) => {
        const s = list.find((x) => x.counterparty === picked);
        if (s) onPick(s);
      }}
    />
  );
}

function TagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const { t } = useTranslation();
  const tags = useTags();
  return (
    <TagsInput
      label={t("newTransaction.tags")}
      placeholder={t("newTransaction.tagsPlaceholder")}
      data={tags.data?.map((x) => x.name) ?? []}
      value={value}
      onChange={(next) => {
        onChange(next.map((x) => x.trim()).filter((x) => x !== "" && x.length <= 50));
      }}
      maxTags={20}
      clearable
    />
  );
}

/**
 * The split between the account's buckets; the rest isn't tied to a bucket.
 * Locked, it only shows the lines.
 */
function BucketSplit({
  account,
  own,
  all,
  active,
  amount,
  lines,
  onChange,
  errors,
  locked,
  needsCycle,
}: {
  account: Account | undefined;
  own: Bucket[];
  all: Bucket[];
  active: Cycle | null;
  amount: string | null;
  lines: SplitLine[];
  onChange: (lines: SplitLine[]) => void;
  errors: Errors;
  locked: boolean;
  /** Bucket lines need an active cycle, unlike a schedule's. */
  needsCycle: boolean;
}) {
  const { t } = useTranslation();
  const money = (value: string) => formatMoney(value, account?.currency);
  const totals = bucketTotals(amount, lines);
  const free = own.filter((b) => !lines.some((l) => l.bucketId === b.id));
  const summary = (
    <>
      <Box p="sm" bg="var(--mantine-color-default-hover)" style={{ borderRadius: 8 }}>
        <Group justify="space-between">
          <Text size="sm">{t("newTransaction.inBuckets")}</Text>
          <Text size="sm">{money(totals.inBuckets)}</Text>
        </Group>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {t("newTransaction.notTied")}
          </Text>
          <Text size="sm" c={totals.over ? "var(--mantine-color-red-text)" : "dimmed"}>
            {money(totals.notTied)}
          </Text>
        </Group>
      </Box>
      {errors.split && (
        <Text size="sm" c="var(--mantine-color-red-text)" role="alert">
          {errors.split}
        </Text>
      )}
    </>
  );

  let body;
  if (locked) {
    body = (
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t("transactions.lockedEdit")}
        </Text>
        {lines.map((l) => (
          <Group key={l.key} justify="space-between">
            <Text size="sm">
              {all.find((b) => b.id === l.bucketId)?.name ??
                t("transactions.unknownBucket", { id: l.bucketId })}
            </Text>
            <Text size="sm">{money(l.amount ?? "0")}</Text>
          </Group>
        ))}
        {summary}
      </Stack>
    );
  } else if (!account) {
    body = (
      <Text size="sm" c="dimmed">
        {t("newTransaction.chooseAccountFirst")}
      </Text>
    );
  } else if (!active && needsCycle) {
    body = (
      <Text size="sm" c="dimmed">
        <Trans
          i18nKey="newTransaction.needsCycle"
          components={{ cycles: <Anchor component={Link} to="/cycles" /> }}
        />
      </Text>
    );
  } else if (own.length === 0 && lines.length === 0) {
    body = (
      <Text size="sm" c="dimmed">
        {t("newTransaction.noAccountBuckets")}
      </Text>
    );
  } else {
    body = (
      <Stack gap="sm">
        {lines.map((l) => {
          const bucket = own.find((b) => b.id === l.bucketId);
          const lineErrors = errors.lines?.[l.key];
          const options = own
            .filter((b) => b.id === l.bucketId || !lines.some((o) => o.bucketId === b.id))
            .map((b) => ({
              value: b.id,
              label: t("newTransaction.bucketOption", {
                name: b.name,
                amount: money(b.current_available_funds),
              }),
            }));
          const update = (change: Partial<SplitLine>) => {
            onChange(lines.map((o) => (o.key === l.key ? { ...o, ...change } : o)));
          };
          return (
            <Group key={l.key} gap="xs" align="flex-start" wrap="nowrap">
              <Select
                aria-label={t("newTransaction.bucket")}
                placeholder={t("newTransaction.bucket")}
                data={options}
                value={l.bucketId}
                allowDeselect={false}
                onChange={(v) => {
                  update({ bucketId: v });
                }}
                error={lineErrors?.bucket}
                style={{ flex: 1, minWidth: 0 }}
              />
              <AmountInput
                aria-label={
                  bucket
                    ? t("newTransaction.amountFor", { name: bucket.name })
                    : t("newTransaction.amountForBucket")
                }
                currency={account.currency}
                value={l.amount}
                onChange={(v) => {
                  update({ amount: v });
                }}
                error={lineErrors?.amount}
                w={130}
              />
              <ActionIcon
                variant="default"
                size={36}
                aria-label={
                  bucket
                    ? t("newTransaction.removeBucket", { name: bucket.name })
                    : t("newTransaction.removeRow")
                }
                onClick={() => {
                  onChange(lines.filter((o) => o.key !== l.key));
                }}
              >
                <IconX size={16} />
              </ActionIcon>
            </Group>
          );
        })}
        <Button
          variant="subtle"
          leftSection={<IconPlus size={16} />}
          style={{ alignSelf: "flex-start" }}
          disabled={free.length === 0}
          onClick={() => {
            // With one bucket left to pick, pick it.
            const only = free.length === 1 ? (free[0]?.id ?? null) : null;
            onChange([...lines, newLine(only, prefillFor(amount, lines))]);
          }}
        >
          {t("newTransaction.addBucket")}
        </Button>
        {summary}
      </Stack>
    );
  }

  return (
    <Stack
      gap="sm"
      style={{ flex: "1 1 360px", minWidth: 0 }}
      component="section"
      aria-label={t("newTransaction.buckets")}
    >
      <Group justify="space-between" align="baseline">
        <Title order={3} size="h5">
          {t("newTransaction.buckets")}
        </Title>
        {account && (
          <Text size="sm" c="dimmed">
            {t("newTransaction.fundedFrom", { name: account.name })}
          </Text>
        )}
      </Group>
      {body}
    </Stack>
  );
}
