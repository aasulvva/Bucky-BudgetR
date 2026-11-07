# Bucky BudgetR

Self-hosted, envelope-style ("bucket") budgeting application.

- **Audience:** not for public use. Hosted on LAN and reachable over Tailscale. Internet exposure may be considered later, but because this is financial data, security comes first.
- **Platform:** web app, usable on desktop and mobile.

## Tech stack

| Layer    | Choice                     |
| -------- | -------------------------- |
| Frontend | React + TypeScript         |
| Backend  | Go (REST API)              |
| Database | PostgreSQL                 |
| Runtime  | Docker containers (Compose): one app container (the frontend embedded in the Go binary), PostgreSQL, Caddy for HTTPS, daily backups |

## Glossary

| Term | Meaning |
| ---- | ------- |
| **Cycle** | A budget period (usually a month, aligned to e.g. payday). |
| **Bucket** | A budget category funded from one bank account. |
| **RA** – Refill Amount | Amount budgeted into a bucket each cycle. |
| **BC** – Bucket Capacity | Max funds a bucket can normally hold. |
| **TF** – Target Funds | What the bucket *should* have (sum of its bucket transactions). |
| **CAF** – Current Available Funds | What the bucket *actually* has, after the Money Allocation Routine. |
| **OVF** | Overflow – money removed from a bucket at cycle change. |

---

## 1. Users

| Field | Notes |
| ----- | ----- |
| User-ID | 6-digit random number |
| Username | unique |
| Password | bcrypt hash |
| Active | bool |
| Admin | bool |
| Preferences | JSON: default refill mode and negative TF handling for new buckets, income rules for *On income* refills (§6), locale (number and date format), language (English, Norwegian bokmål or nynorsk; follows the locale by default), time zone, cycle rule (§3) |
| Created / Modified, Created by | audit |

**Initial setup:** on first start a default admin account is created with password `BuckyBudgetR_ADMIN_Pa$$w0rd`. The user must change it at first login. The default can be overridden with an environment variable.

**User management (admins):** admins create users, activate and deactivate them, grant and revoke admin, and reset passwords. A new or reset user gets in with what the admin picks, shown to the admin once: a **link** (the default) where they choose their own password and are logged in, which works once for 24 hours; or a generated **temporary password**, which they must change at their next login. A new link or password voids the old link, and a reset ends the old password and sessions at once. Users are never deleted: deactivating blocks login and ends their sessions, and keeps their data. Admins manage accounts only, never other users' money. An admin can't change their own account there (they use Settings), and the last active admin can't be demoted or deactivated.

**Recovery:** when no admin can log in, `bucky-server reset-password --user <name>` on the server (`docker compose exec app …` in production) gives that user a temporary password (printed), makes them an active admin and ends their sessions.

## 2. Bank accounts

| Field | Notes |
| ----- | ----- |
| Account-ID | 4-digit random number |
| Owner | user |
| Name | unique per user (ignoring case) among accounts that aren't deleted |
| Currency | ISO 4217 code, e.g. NOK. Only real currencies with at most 2 decimals (not gold, test codes or e.g. KWD). Set when the account is created and can't be changed. |
| Account type | usage, savings, BSU, fund/ASK, investment |
| Expected income | optional, ≥ 0: the income expected on the account per cycle, which Budget setup compares the refill amounts with (§9) |
| Deleted | soft-delete flag |
| Created / Modified | audit |

**Rules**
- The balance is never stored. It is calculated from bank transactions. A balance at a point in time counts the transactions dated before it.
- **Snapshots:** to keep this fast, pre-calculate the balance at fixed points (e.g. 1 January each year) and add only the transactions after that point. Bucket TF uses the same mechanism.
- New accounts get an **Opening Balance (OPB)** transaction.
- The balance can be corrected from the Accounts screen, which creates a **Balance Adjustment (BLA)** for the difference between the entered balance and the balance at that moment.
- **Deleting** an account settles it first, all in one step. Money left in it is **transferred (TRF)** to another account or **adjusted to 0 (BLA)**, as the user chooses. Every bucket funded from it gets a **new source account**, or the user deletes those buckets in Bucket setup first. Money and buckets only move to an account in the same currency. The account's transactions are kept.

## 3. Cycles

A budget period. Usually a month, but its start and end dates can be set freely, e.g. to match payday.

| Field | Notes |
| ----- | ----- |
| Cycle-ID | `<6-digit User-ID><6-digit random>` |
| Owner | user |
| Start | the moment the cycle starts, stored in UTC |
| End | the moment the cycle ends (exclusive), stored in UTC |
| State | future / active / finished |
| Generated | planned by the cycle rule, and not moved by hand since |

**Rules**
- Cycles apply to the whole user. A user has **at most one active cycle**.
- The user picks start and end **dates**. They are stored as the UTC moments of local midnight: a cycle from 01.11 to 30.11 in Oslo runs from 31.10 23:00 UTC up to 30.11 23:00 UTC.
- A user's cycles **never overlap**. One may start exactly where another ends.
- If no cycle is active, the user is prompted to start the next planned cycle or create one. Only the earliest planned cycle can be started. Started before its planned start, it starts now; otherwise it keeps its planned start.
- Cycles are **ended manually**, and **end on their intended dates**:
  - Once the active cycle's planned end has passed, bucket transactions are refused until the user **extends** the cycle (moves its end later) or **ends** it. Ended late, it keeps its planned end.
  - Ended **early**, it ends now. If the next planned cycle begins later, the user chooses to **start it now** (its start moves to where the ended cycle ended) or to **leave a gap**. In a gap there is no active cycle, so transactions can't have bucket lines; the UI says so.
  - A next planned cycle that begins where the ended one ended starts automatically.
- Extending the active cycle pushes the next planned cycle's start along if they would overlap. The active cycle's start can't change, and its end can't move before now or before its last bucket transaction.
- Future cycles can be planned, edited and deleted in advance. Finished cycles are read-only.
- Ending a cycle runs the **cycle-end routine**, then the **cycle-start routine** of the cycle that starts (see §6).

**Cycle rule** (optional, in the preferences; #72)
- Plans cycles automatically, e.g. from payday: a **day of the month** (1–31; a day the month doesn't have is its last day), moved to the **previous working day** (default), the **next working day**, or **not moved** when it's a weekend or a holiday. The **holidays** are none (weekends only) or **Norwegian bank holidays**: the public holidays, Easter-based ones included, plus 24 and 31 December.
- Each planned cycle runs from one of the rule's dates up to the next, at local midnight in the user's **time zone** (a preference, set to the browser's zone the first time). The cycles are adjacent, so the next one starts by itself when the active one ends on time.
- The rule keeps **N cycles planned** (1–12, default 3). It tops up when a cycle starts or ends, hourly, and when the rule changes. New cycles go after the latest cycle, on the first of the rule's dates on or after its end (and not before today's period), so there may be a gap until then. It never touches the active or finished cycles, or planned cycles the user made or moved.
- Changing the rule (or the time zone) replans the generated cycles that haven't started. Turning it off keeps the planned cycles. A deleted planned cycle is planned again; to plan fewer, lower N.
- *Plan a cycle* and the start prompt suggest the rule's dates.

## 4. Buckets

| Field | Notes |
| ----- | ----- |
| Bucket-ID | `<6-digit User-ID><4-digit random>` |
| Owner | user |
| Name | |
| Source bank account | must be owned by the same user. The bucket uses this account's currency. |
| RA | Refill Amount (0 for a *Fully manual* bucket) |
| BC setting | *Multiplier* (BC = RA × multiplier, multiplier ≥ 1.00) or *Fixed amount*; a *Fully manual* bucket has *Fixed amount* or *No cap* |
| BC multiplier / BC fixed amount | per BC setting |
| TF | derived from bucket transactions |
| CAF | stored result of the Money Allocation Routine |
| Keep funds | bool – roll leftover funds over to the next cycle. If enabled, BC should normally be higher than RA so leftovers have room to roll over. |
| Negative TF | *Carry as debt* (default) / *Clear on refill* – what the refill does with an overspend (§6). Only used with Keep funds; new buckets get the user's default (preferences). |
| Refill mode | *Auto* (at cycle start) / *Manual* (button, once per cycle) / *On income* (when an income triggers it, see §6) / *Fully manual* (never refilled; #76) |
| Overflow destination | *Unallocated* / *Savings distribution* / *Specific savings target* |
| Priority | bool – funded before non-priority buckets (housing, transport, groceries…) |
| Importance | 1–10, weight in the allocation routine |
| Refilled | derived: whether the bucket has been refilled in the active cycle (§6) |
| Deleted | soft-delete flag |
| Created / Modified | audit |

**Rules**
- RA can never be above BC. With a fixed BC, BC is raised automatically when RA exceeds it.
- New buckets get an **Opening Funds (OPF)** transaction when the opening funds aren't 0. Like every bucket transaction, it needs an active cycle.
- The source account can only change to an account in the same currency, since TF is an amount in that currency. CAF is reset to 0 and the allocation routine funds the bucket from the new account.
- **Deleting** a bucket releases its remaining TF with a **BUA** to 0, so the money becomes unallocated in the source account (a negative TF is brought up to 0 the same way). That needs an active cycle unless TF is already 0. The bucket's transactions stay.
- The new user preference only sets the *default* refill mode. Each bucket decides for itself.
- A **Fully manual** bucket (#76) is never refilled. It has no RA (always 0), Keep funds is always on, and its BC is a fixed amount or none. Its funds only change by hand: *Add funds* and *Remove funds* on the Buckets screen (§9), which are *This cycle only* adjustments (BUA) from or to the source account's unallocated money, and moves to or from other buckets (TF only, BAT). Adding, or a move into it, can't take TF above a fixed BC; removing stops at 0; adding may take more than the account has unallocated, which leaves the account short. Switching a bucket to it sets RA to 0 and turns Keep funds on, keeping TF; switching back asks for an RA and a BC again.
- *Savings distribution* and *Specific savings target* become available with the savings module (§8). Until then, overflow is always *Unallocated* (the money stays in the source account).

**Figures per cycle** (Buckets screen, "used X of Y"). Calculated from bucket lines, never stored:
- **Start:** TF when the cycle began, the sum of the bucket's lines in earlier cycles.
- **Budget:** start + this cycle's lines except EXP and OVF (REF, INC, OPF, BUA, BAT; reductions count negative).
- **Used:** the cycle's EXP lines, net of corrections.
- **Overflow:** the cycle's OVF lines, at cycle end or when a refill pushes TF above BC.
- **Left:** budget − used − overflow. This is TF at the end of the cycle (the current TF while the cycle is active).

A finished cycle keeps its figures: lines from later cycles don't change them.

`GET /cycles/{id}/bucket-figures` returns these per bucket, with the budget split into its parts (start, refills, income, opening funds, adjustments, transfers). The Buckets screen shows the parts that aren't 0 as a breakdown: "Start 500.00 + refill 1 500.00".

## 5. Transactions

Every transaction has a **header**. Each affected bank account or bucket gets its own **line** (bank transaction / bucket transaction) linked to that header.

Transactions are immutable. An edit creates a **correction** (e.g. 100 NOK corrected to 150 NOK creates a +50 NOK adjustment, which the UI shows as a single 150 NOK transaction). A transaction entered by mistake can be **reversed**.

- **What can be corrected:** INC, EXP and TRF, and the system types OPB and BLA. REF, OVF, OPF, BUA and BAT can't: the routines and Bucket setup own them. A reversed transaction can't be corrected or reversed again.
- **What a correction changes:** amounts, bucket lines, counterparty and tags. Its lines hold the difference and keep the original time. Every correction carries the counterparty and tags, so the newest one's are the effective values; a change of only these is a correction without lines.
- **Another account:** moving an INC, EXP or TRF to another account reverses it and records it again on the new account at the original time. The new transaction *replaces* the old one, and both point to each other.

### 5.1 Header

| Field | Notes |
| ----- | ----- |
| Transaction-ID | `<YYYYMMDD><8-digit random>`, the UTC date of the transaction time |
| Parent transaction | set on corrections |
| Correction type | none / adjustment / reversal |
| Transaction type | see 5.4 |
| Transaction time | date and time, stored in UTC and shown in local time. The ID's date is the UTC date. |
| Company/Person | counterparty for external transactions |
| Tags | per-user, free text; reused by name (case-insensitive) |
| Bank lines / bucket lines | links |
| Created, User | audit (immutable: never modified) |

### 5.2 Bank transaction (line)

| Field | Notes |
| ----- | ----- |
| Transaction-ID | `<4-digit Account-ID><12-digit random>` |
| Bank account | |
| Amount | **in the account currency – this is the amount that counts** |
| Original amount, currency, exchange rate | for foreign-currency purchases. For reference only. The rate is derived from the amounts. |
| Created, User | audit (immutable: never modified) |

For foreign-currency transactions, record the amount in the account currency as shown by your bank, fees included.

### 5.3 Bucket transaction (line)

| Field | Notes |
| ----- | ----- |
| Transaction-ID | `<10-digit Bucket-ID><14-digit random>` (24 digits) |
| Bucket | |
| Amount | |
| Cycle | the cycle this line belongs to |
| Created, User | audit (immutable: never modified) |

### 5.4 Transaction types

| Code | Type | Bank lines | Bucket lines | Created by | Purpose |
| ---- | ---- | ---------- | ------------ | ---------- | ------- |
| OPB | Opening Balance | 1 | – | system | Initial balance of a new account |
| BLA | Balance Adjustment | 1 | – | system (Accounts screen) | Sync the app balance with reality (e.g. investment gains/losses) |
| INC | Income | 1 | 0..n | user | Money from an external source (salary, gifts, sales…) |
| EXP | Expense | 1 | 0..n | user | Money to an external party (purchases, rent, bills…) |
| TRF | Transfer | 2 | – | user | Between your own accounts |
| INP | Internal Payment | 2 | 0..n | user | Payment to another BuckyBudgetR user's account. The recipient doesn't need to register an income. |
| OPF | Opening Funds | – | 1 | system | Initial TF of a new bucket |
| REF | Refill | – | 1 | system | Refills a bucket (§6) |
| BUA | Budget Adjustment | – | 1 | system (Bucket setup) | Change a bucket's TF |
| BAT | Budget Adjustment Transfer | – | 2 | system (Bucket setup) | Move TF between buckets |
| OVF | Overflow | – | 1 | system | Removes leftover/overflow at cycle change (§6) |

Only **INC, EXP, TRF and INP** can be created from the *Create transaction* screen.

### 5.5 Rules
- A bucket line belongs to the **active cycle** of the bucket's owner, and the transaction time must fall inside that cycle.
- **Corrections and reversals that affect buckets are only allowed inside the active cycle.** Once a cycle is finished, its bucket lines are locked. The bank amount, counterparty and tags can still be corrected, as long as the bucket lines still fit within the amount.
- An Internal Payment can only be created by the payer. Users cannot "request" money from other users.
- **Signs:** INC lines are positive and EXP lines negative, on both bank and bucket lines. The user enters positive amounts; the type gives the sign. A TRF's two lines mirror each other.
- **Bucket lines on INC/EXP:** each bucket must be funded from the transaction's bank account (this may change with cash support, #60). Together they can't exceed the bank amount; the remainder simply isn't tied to a bucket.
- **TRF** goes between two of the user's accounts in the same currency. Transfers between currencies come with multi-currency (#33).
- **No future dates:** a transaction records what has happened, so its time can't be later than now. Planned payments are scheduled transactions (#31).
- **Reading:** the transaction list shows each transaction merged with its corrections (effective amounts, flagged as corrected or reversed); a reversed one also carries its amounts from just before the reversal (`before_reversal`), so the list can still show what it was. A transaction's history shows the original and each correction.
- **Suggestions:** `GET /tags` lists the user's tags, most recently used first. `GET /counterparties` lists the counterparties of incomes and expenses, each once (ignoring case), newest first, with the effective account, tags and buckets of its newest transaction that isn't reversed.
- **Math:** calculate with full precision. Stored amounts use 2 decimals, rounded half away from zero (0.005 → 0.01, −0.005 → −0.01). Exchange rates use 8 decimals.

## 6. Cycle routines

The routines run in the same database transaction as ending or starting the cycle, so they happen exactly once.

### Cycle end
1. Check that CAF fits the accounts (§7), so the funded part is known. This doesn't reallocate otherwise.
2. For each bucket with **Keep funds off** (so never a *Fully manual* one), an **OVF** transaction brings a positive TF to 0. Only the funded part (CAF) is real money for the overflow destination; the unfunded rest simply disappears. A negative TF stays until the next refill.
3. The OVF is dated now, or just before the cycle's end if it is ended late, so it belongs to the ending cycle.

### Cycle start / refill
A refill happens according to each bucket's **refill mode**:
- **Auto:** at cycle start, dated at the cycle's start.
- **Manual:** via a button on the Buckets screen (`POST /buckets/{id}/refill`), dated now. Only buckets with this mode.
- **Fully manual:** never. Such a bucket isn't refilled when created either, and opening funds don't count as a refill (§4).
- **On income:** when an income (INC) triggers it. It refills every *On income* bucket funded from the income's account that hasn't been refilled in this cycle, dated at the income's time. An income triggers it when:
  - its **"Triggers refill"** flag is set (the UI pre-checks it when the account has *On income* buckets left to refill, or a rule matches), or
  - the flag isn't given and one of the user's **income rules** (preferences) matches: the same counterparty, ignoring case, and an amount of at least the rule's minimum (e.g. the employer, ≥ 20 000). An explicit flag overrides the rules.

  The income must fall inside the active cycle; an explicit flag on an income outside it is refused. The flag can also be set or cleared later with a correction. **Reversing** the income (or moving it to another account) undoes its refills: their REF and OVF are reversed and the buckets can be refilled again. Refills in a finished cycle stay.

- **New bucket:** a bucket created while a cycle is running can be refilled at once (`refill` on `POST /buckets`, Bucket setup's *Refill now*), dated now, whatever its mode. Creating it with **opening funds** (OPF) instead also counts as its refill for that cycle, so no later refill in the cycle changes the amount. *Start at 0* leaves it to its refill mode: a *Manual* or *On income* bucket can still be refilled in the cycle, an *Auto* one waits for the next cycle's start.

A bucket is refilled **at most once per cycle** (tracked per bucket and cycle). The REF amount depends on Keep funds:
- **Keep funds off:** TF is set to RA, so REF = RA − current TF (a negative TF is cleared).
- **Keep funds on:** RA is added to TF. If the new TF is above BC, the excess is removed with an **OVF** transaction and sent to the overflow destination. A negative TF depends on the bucket's *Negative TF* option:
  - **Carry as debt** (default): RA is added as usual, so the overspend is paid back from the refill (TF −300, RA 4 000 → TF 3 700).
  - **Clear on refill:** TF is set to RA, as without Keep funds, with one REF of RA − TF (TF −300, RA 4 000 → REF 4 300, TF 4 000). Undoing the refill brings the debt back.

  The debt is only cleared at a refill: a bucket that isn't refilled in a cycle keeps it.

A REF or OVF of 0 isn't recorded, but the refill still counts.

A refill raises TF without adding money, so on its own it only moves CAF when the account crosses Σ TF (§7). An income that triggers a refill is money no bucket owns, so its account is recalculated with the refilled TFs (and again when its refills are undone).

## 7. Money Allocation Routine

Funds the buckets: works out how much of each source account's money backs each bucket (CAF), based on TF.

- Runs **per source account**, per user.
- **Enough funds** (account balance ≥ Σ TF of its buckets): CAF = TF for every bucket. The leftover is stored and displayed as *unallocated*. Later, unallocated money can optionally be passed to the savings distribution.
- **Not enough funds:**
  1. Priority buckets are funded first.
  2. The remaining funds are split by weight: `CAF_i = available × (TF_i × importance_i) / Σ(TF_j × importance_j)`. No bucket gets more than its TF, and any excess is split again among the rest. If even the priority buckets can't be fully funded, the same split is used among them.
- Buckets with TF ≤ 0 get CAF = 0. A negative account balance counts as 0 available.
- **Rounding:** shares are calculated at full precision, rounded down to cents, and the leftover cents go one each to the buckets with the largest remainders, so the CAFs add up to exactly what was split.
- CAF is **stored**, so funds aren't redistributed on every change. After every transaction, for the accounts it touched (directly or as a bucket's source):
  - **A bucket line moves its own bucket's CAF** by its amount: an expense of 50 from Groceries takes 50 of Groceries' CAF, and the other buckets keep theirs.
  - **Moving funds between buckets on one account (BAT) takes covered money along:** the sending bucket hands over up to the moved amount of its CAF (a gap it had stays with it), and the receiving bucket takes it up to its TF; what it can't take goes back. Between accounts, each account follows the rules below.
  - Each CAF is then kept to 0 ≤ CAF ≤ TF.
  - The account is **recalculated** only when:
    - part of the transaction's bank line isn't on a bucket: an income, expense or transfer without bucket lines, or the part of a split that isn't tied to a bucket. That is money no bucket owns, however little;
    - a bucket's CAF is spent (0 or below), or an income into an overspent bucket leaves its CAF above TF;
    - the balance crosses Σ TF of the account's buckets, up or down (a refill can do that);
    - CAF no longer fits (Σ CAF above the balance), or the balance covers Σ TF but CAF doesn't match it.
  - Otherwise nothing moves, so an underfunded account can leave a refilled bucket uncovered. **Reallocate** on the Buckets screen (`POST /accounts/{id}/reallocate`) recalculates it by hand.
- **Bucket changes recalculate at once:** creating or deleting a bucket, moving it to another account, or changing its priority or importance recalculates the accounts involved right away.
- **Unallocated** is the account balance minus the CAF of its buckets. It is derived from the stored CAF rather than stored separately.

## 8. Savings module *(later)*

- **Savings distribution:** an amount to split across savings targets according to priority rules, which are set as amount thresholds on each target.
- **Holding money set aside for a specific target**, e.g. an emergency fund in a savings account, money for a fund, BSU.
- Possibly a *savings transaction* type, used to move money into the distribution and to record funds waiting to go to targets.

## 9. UI

### Navigation

Desktop and mobile use the same groups (decided in #8; wireframes in the design canvas linked there). Post-MVP screens are marked *later*.

| Group | Screens |
| ----- | ------- |
| Overview | Dashboard |
| Transactions | Transactions (list, filters, corrections) |
| (+) New | Create transaction |
| Budget & Reporting | Buckets, Accounts, Cycles, Savings *(later)*, Stats & reports *(later)* |
| Setup | Account setup, Bucket setup, Budget setup, Savings setup *(later)* |
| Profile menu | Settings, Admin (admins only), What's New, About, the color scheme, the app's version, Sign out |

- **Desktop:** a side menu. Dashboard and Transactions are links, New transaction is a button, and Budget & Reporting and Setup are groups that expand and collapse. Budget & Reporting and the group of the current screen start open. The profile button (avatar and username) sits at the bottom and opens the profile menu.
- **Mobile:** bottom tabs `Overview · Transactions · (+ New) · Budget · Setup`. A tab with several screens opens them in a sheet. The header shows the screen's name and the profile avatar, which opens the profile menu.
- **Version:** the app is versioned `vX.YY.ZZ`: X goes up when a milestone is done (1 = MVP), YY for a new feature, ZZ for a bugfix or minor change. The login page and the profile menu show it (with *· dev* in development). **About** shows the version, the commit it was built from and the environment (development or production). **What's New** lists every version's changes, each headed `<title> (yyyy-mm-dd) - vX.YY.ZZ`, in the app's language. It pops up when the app opens on a newer feature or major version than the user last saw (`whats_new_seen`), not after a patch, showing what changed since; closing it saves the version as seen, and *Don't show this after updates* (or the Settings switch) turns that off (`whats_new_popup`).
- **Notifications** (#57, later): above the profile button on desktop, a bell next to the avatar on mobile.
- The day-to-day budget screen is **Cycles**. Budget setup is part of Setup.

### Screens

| Screen | Content |
| ------ | ------- |
| Dashboard | The user's own layout of widgets (#37): the active cycle and its days left (or *Start cycle*), and the next planned one unless switched off · budget health per source account (how much of its buckets' TF it covers, short or unallocated, buckets not fully covered or overspent) · bucket status (*Needs attention* by default: overspent, not fully covered, or more than 90 % used, worst first; or *All buckets*, *Most used*, *One account* (#89: what its buckets have left, short or unallocated, then each of its buckets; if the account is deleted, the widget says so and offers to choose another), *One bucket*) · account balances with unallocated and totals per currency, or *One account* (its balance, what's left in its buckets, short or unallocated) · recent transactions (the user's own types, 5 by default, up to 20). **Edit dashboard** adds, removes and arranges them (drag by the handle, or the arrow buttons), and makes each half or full width on wide screens (one column on phones). Every type can be added more than once, each copy with its own settings; adding one shows its settings first (Budget health, whose only setting is the title, is added at once). Each widget's title is automatic (the bucket's or account's name for *One bucket* and *One account*, otherwise the widget's name) or a custom one of up to 40 characters, and Bucket status can hide its mode line (e.g. *Needs attention*). **Done** saves the layout, **Cancel** throws the changes away, and **Reset to default** (after asking) puts back the five widgets in the order above. An empty Dashboard offers *Add widget*. The layout is saved in the preferences (`dashboard.widgets`, at most 30); without one, the five widgets show with the per-type settings saved before #37. **Desktop and mobile** (#99): each user has two layouts, saved with the user so they follow them to every device. Screens narrower than the app shell's breakpoint (where the side navigation goes) show the mobile layout, in one column; wider screens show the desktop one. Edit mode edits either layout (a *Desktop | Mobile* switch, starting on the current screen's; on a wide screen the mobile layout shows as narrow as a phone), and Done saves both. *Copy from desktop* / *Copy from mobile* (after asking) replaces the edited layout with a copy of the other, and *Reset to default* resets only the edited one: the mobile default is *Needs attention*, the cycle and the recent transactions. Until the mobile layout is saved (`dashboard.mobile_widgets`), it's a copy of the desktop one, or the mobile default when nothing is saved at all. A widget's settings belong to its layout. **Money in and out** (#90): income, expenses and/or their balance (income − expenses) over the last *x* days (1–366, today included), today, this week (from the locale's first day), this cycle, this month or this year, in local time. On all accounts it sums INC and EXP of the accounts in the app's currency (others are left out, with a note; converting them is #133); on one account, transfers in and out count as income and expenses, in its currency. Balance adjustments, opening balances and bucket-only events don't count, and a transaction counts on its original's date with its corrections. Each figure opens Transactions with the same period, account and type. The figures come from `GET /api/v1/reports/flows`. Graphs come later. |
| Create transaction | INC, EXP, TRF (INP later). The user enters a positive amount; the type gives the sign. Defaults: now, and the last account used in this browser. An income or expense can be split between the buckets funded from its account (needs an active cycle, and the time inside it); a new row starts with what isn't tied to a bucket yet, and the rest stays in the account. Changing the amount moves the split with it: a split that took the whole amount is scaled to the new one, and a partial split stays until it no longer fits, then shrinks to the amount (locked lines never move). Counterparty and tags autocomplete from earlier values, and picking an earlier counterparty fills in its last account (unless chosen), tags (if none) and buckets (if none). An income has a "Triggers refill" checkbox (§6), shown while the time is inside the active cycle and pre-checked when the account has *On income* buckets waiting or an income rule matches. Save goes back; *Save and add another* keeps the type, account and date. On mobile, Save stays visible. |
| Buckets | Per source account: used this cycle out of the budget (the bar turns yellow above 90 %, red when overspent), and left per bucket. Left is what the account backs (CAF); while that's less than TF, TF is struck through beside it with a bar of how much is covered. An overspent bucket (negative TF) shows its TF in red with a red warning, and says what the next refill does with it: *Debt · paid back at the next refill* (Keep funds, carry as debt) or *Overspent · cleared at the next refill*. List or grid view, drill into transactions, manual refill button (once per cycle), **Add funds** and **Remove funds** instead for a *Fully manual* bucket (a dialog with the amount and a preview: TF before and after, a warning when the account ends up short, refused above a fixed BC or below 0; shown while a cycle is running, Remove disabled at TF ≤ 0), a Reallocate button in the header of an account that is underfunded or leaves a bucket uncovered; a cog opens the bucket in Bucket setup. **Transactions** (a button per bucket, opening a dialog): the bucket's lines in a cycle (the active one by default, or a finished one), newest first, with what's left (TF) after each, and what it had at the cycle's start when that isn't 0 (Keep funds, or an overspend carried over). In the active cycle, a note says when the account covers less (CAF), which is why Buckets shows less left. *Show* narrows it to the bucket-only types (REF, OVF, OPF, BUA, BAT) or one type, a BAT names the other bucket, and a row opens the transaction on Transactions. The parts of the cycle breakdown (refill, income, opening funds, adjusted, moved) open it showing that type. Read-only. **Adjust funds** (a button per bucket, opening a dialog; applied at once, `POST /buckets/{id}/adjustment`): *This cycle only* (set TF to 0 or more, may exceed BC → BUA) · *From next refill* (set RA, BC follows its rules, TF unchanged) · *Both* (set RA and change TF by the same amount → BUA; TF may go below 0). A preview shows the change first; a *Fully manual* bucket has no RA, so its dialog only moves funds (TF only). **Move funds to another bucket** in the same currency (`POST /buckets/{id}/transfer`) with the same three modes: TF (→ BAT; the sender may go below 0), RA (the sender needs at least the amount), or both. |
| Bucket setup | Create/edit (name, importance, priority, options)/delete buckets, listed with their IDs (and RA, or *Fully manual*). The refill mode is a list with a hint per mode; *Fully manual* hides RA, Keep funds, *When overspent* and the overflow destination, and offers *No cap* or a fixed capacity. With Keep funds, *When overspent* picks *Carry it as debt* or *Clear it at the refill* (§6); a new bucket starts from the preference. A new bucket in a running cycle starts with *Refill now* (default), *Set starting funds* or *Start at 0* (§6); a *Fully manual* one with the last two only. Delete is one confirmation that says where what's left goes (unallocated in the source account, §4). Changing a bucket's funds is *Adjust funds* on Buckets. |
| Budget setup | All buckets at once except *Fully manual* ones, which have no RA (a note per account says how many are left out), by source account: enter the expected income per cycle on each account, set RAs inline, and see live what the RAs take of the income (allocated, %, left or *over by*) and each bucket's share and capacity. One Save sets every changed RA at once (`POST /buckets/refill-amounts`, all or nothing) as the *Future* adjustment: TF is unchanged and no transaction is recorded; a fixed BC below the new RA is raised. **Also change this cycle** (a switch in the save bar while a cycle is running, disabled when it's overdue; #81) makes it *Both* for each bucket already refilled in the active cycle: a BUA of the change in RA, so TF moves by the same amount (it may go below 0). A bucket not refilled yet this cycle (Manual, or On income waiting) only gets the new RA, which its refill then uses. Saving with it on first shows each bucket's TF change (or that it waits for its refill) and, per account, how much the balance doesn't cover afterwards. Leaving with unsaved changes asks first |
| Accounts | Balances, drill into transactions, balance adjustment (BLA), register interest (INC); a cog opens the account in Account setup |
| Cycles | The active cycle (extend, end) and planned cycles, the ones the cycle rule planned marked *From rule*. Ending asks for confirmation, listing the buckets that will be emptied (OVF) and the Auto buckets the next cycle refills, with the amounts (REF, and any overflow). Without an active cycle, a prompt offers to start the planned one or a new one. |
| Account setup | Create/manage bank accounts |
| Transactions | Newest first, grouped by day, a page at a time. Filters (kept in the URL, so Accounts and Buckets drill in with theirs): counterparty search, account, bucket, cycle (the active one by default, or all), type, tag and dates. Refills, overflow and bucket adjustments are hidden unless *Show refills & adjustments* is on. A row shows the effective amount, marked *Edited*, *Reversed* (with the amount it had) or *Moved*. The detail (beside the list, full screen on mobile) shows its ID, the account lines and bucket lines as separate sections, and the history. **Edit** opens the Create transaction form filled in: the type and time stay, only what changed is sent as a correction, and another account moves it. **Reverse** asks first. While the bucket lines are in a finished cycle they can't change: Reverse is disabled with the reason, and Edit still changes the amount (not below what's in the buckets), counterparty and tags. System transactions can't be edited or reversed. |
| Savings | Expected deposits per savings target. "Done" creates the transfers |
| Savings setup | Savings targets and priority rules |
| Stats & reports | Spending and balance graphs over time; yearly PDF report; filter by bucket, tag, counterparty. *Done so far (#120, #121):* the Stats API (`GET /api/v1/stats/series`: spending, income or balances per hour, day, week, month, year, cycle or for the whole period, cut in the user's time zone, per currency, account or bucket, with the Transactions list's filters) and the shared period and resolution pickers (the last N days, weeks or months; this or the previous cycle, month, quarter, half-year or year; custom dates). The graphs come with #122. |
| Settings | Profile menu. Password, preferences (locale, language, time zone, default refill mode, what new Keep funds buckets do when overspent, whether What's New pops up after updates, income rules), the cycle rule (§3) with a preview of the next cycles, data export/import *(later)* |
| Admin | Profile menu, admins only. Users: create, activate/deactivate, make/remove admin, reset password (a setup/reset link or a temporary password, shown once) |

## 10. Roadmap

**MVP:** users/auth, bank accounts, transactions (OPB, BLA, INC, EXP, TRF + bucket types), corrections, cycles, buckets, refill/overflow, allocation routine, core screens, deployment.

**Post-MVP:** scheduled & recurring transactions (auto-apply or approval queue with a due date), internal payments, multi-currency, stats & reports, savings module, dashboard widgets, data export/import.

## 11. Open questions & future ideas

- Credit card transactions.
- Basic spending analysis (e.g. warnings to slow down in a category).
- Better investment tracking.
- Shared budgeting for couples (shared "Groceries" bucket, separate "Hobby" buckets). Note: the owner-embedded IDs assume a single owner.
- Which stats and reports to offer.

## 12. Dev rules

- The REST API must be documented (OpenAPI spec).
- Work on branches. `main` is only changed through pull requests.
