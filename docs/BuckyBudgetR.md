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
| Runtime  | Docker containers (Compose) |

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
| Preferences | JSON (e.g. default refill mode for new buckets) |
| Created / Modified, Created by | audit |

**Initial setup:** on first start a default admin account is created with password `BuckyBudgetR_ADMIN_Pa$$w0rd`. The user must change it at first login. The default can be overridden with an environment variable.

## 2. Bank accounts

| Field | Notes |
| ----- | ----- |
| Account-ID | 4-digit random number |
| Owner | user |
| Name | unique per user (ignoring case) among accounts that aren't deleted |
| Currency | e.g. NOK. Set when the account is created and can't be changed. |
| Account type | usage, savings, BSU, fund/ASK, investment |
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

**Rules**
- Cycles apply to the whole user. A user has **at most one active cycle**.
- The user picks start and end **dates**. They are stored as the UTC moments of local midnight: a cycle from 01.11 to 30.11 in Oslo runs from 31.10 23:00 UTC up to 30.11 23:00 UTC.
- If no cycle is active, the user is prompted to create one.
- Cycles are **ended manually**, and can be ended before their end date.
- Future cycles can be set up in advance. When a cycle ends, the next applicable future cycle starts automatically.
- Ending a cycle runs the **cycle-end routine**, then the **cycle-start routine** of the next cycle (see §6).

## 4. Buckets

| Field | Notes |
| ----- | ----- |
| Bucket-ID | `<6-digit User-ID><4-digit random>` |
| Owner | user |
| Name | |
| Source bank account | must be owned by the same user. The bucket uses this account's currency. |
| RA | Refill Amount |
| BC setting | *Multiplier* (BC = RA × multiplier, multiplier ≥ 1.00) or *Fixed amount* |
| BC multiplier / BC fixed amount | per BC setting |
| TF | derived from bucket transactions |
| CAF | stored result of the Money Allocation Routine |
| Keep funds | bool – roll leftover funds over to the next cycle. If enabled, BC should normally be higher than RA so leftovers have room to roll over. |
| Refill mode | *Auto* (at cycle start) / *Manual* (button, once per cycle) / *On income* (see §6) |
| Overflow destination | *Unallocated* / *Savings distribution* / *Specific savings target* |
| Priority | bool – funded before non-priority buckets (housing, transport, groceries…) |
| Importance | 1–10, weight in the allocation routine |
| Deleted | soft-delete flag |
| Created / Modified | audit |

**Rules**
- RA can never be above BC. With a fixed BC, BC is raised automatically when RA exceeds it.
- New buckets get an **Opening Funds (OPF)** transaction.
- The new user preference only sets the *default* refill mode. Each bucket decides for itself.
- *Savings distribution* and *Specific savings target* become available with the savings module (§8). Until then, overflow is always *Unallocated* (the money stays in the source account).

**Figures per cycle** (Buckets screen, "used X of Y"). Calculated from bucket lines, never stored:
- **Start:** TF when the cycle began, the sum of the bucket's lines in earlier cycles.
- **Budget:** start + this cycle's lines except EXP and OVF (REF, INC, OPF, BUA, BAT; reductions count negative).
- **Used:** the cycle's EXP lines, net of corrections.
- **Overflow:** the cycle's OVF lines, at cycle end or when a refill pushes TF above BC.
- **Left:** budget − used − overflow. This is TF at the end of the cycle (the current TF while the cycle is active).

A finished cycle keeps its figures: lines from later cycles don't change them.

## 5. Transactions

Every transaction has a **header**. Each affected bank account or bucket gets its own **line** (bank transaction / bucket transaction) linked to that header.

Transactions are immutable. An edit creates a **correction** (e.g. 100 NOK corrected to 150 NOK creates a +50 NOK adjustment, which the UI shows as a single 150 NOK transaction). A transaction entered by mistake can be **reversed**.

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
- **Corrections and reversals that affect buckets are only allowed inside the active cycle.** Once a cycle is finished, its bucket lines are locked.
- An Internal Payment can only be created by the payer. Users cannot "request" money from other users.
- **Math:** calculate with full precision. Stored amounts use 2 decimals, rounded half away from zero (0.005 → 0.01, −0.005 → −0.01). Exchange rates use 8 decimals.

## 6. Cycle routines

### Cycle end
1. Run the Money Allocation Routine so CAF is up to date.
2. For each bucket with **Keep funds off**, remove the remaining **CAF** with an **OVF** transaction and send it to the bucket's overflow destination.

### Cycle start / refill
A refill happens according to each bucket's **refill mode**:
- **Auto:** at cycle start.
- **Manual:** via a button on the Buckets screen, once per cycle.
- **On income:** when an income transaction triggers the refill *(exact trigger TBD, see open questions)*.

A bucket is refilled **at most once per cycle**. The REF amount depends on Keep funds:
- **Keep funds off:** TF is set to RA, so REF = RA − current TF.
- **Keep funds on:** RA is added to TF. If the new TF is above BC, the excess is removed with an **OVF** transaction and sent to the overflow destination.

## 7. Money Allocation Routine

Funds the buckets: works out how much of each source account's money backs each bucket (CAF), based on TF.

- Runs **per source account**, per user.
- **Enough funds** (account balance ≥ Σ TF of its buckets): CAF = TF for every bucket. The leftover is stored and displayed as *unallocated*. Later, unallocated money can optionally be passed to the savings distribution.
- **Not enough funds:**
  1. Priority buckets are funded first.
  2. The remaining funds are split by weight: `CAF_i = available × (TF_i × importance_i) / Σ(TF_j × importance_j)`. No bucket gets more than its TF, and any excess is split again among the rest. If even the priority buckets can't be fully funded, the same split is used among them.
- Buckets with TF ≤ 0 get CAF = 0.
- CAF is **stored**, so funds aren't redistributed on every change. The check runs after every transaction, and a recalculation happens when:
  - CAF exceeds the available funds;
  - the available funds now cover TF;
  - the available funds are ≥ 1.00 above CAF (while CAF < TF).

## 8. Savings module *(later)*

- **Savings distribution:** an amount to split across savings targets according to priority rules, which are set as amount thresholds on each target.
- **Holding money set aside for a specific target**, e.g. an emergency fund in a savings account, money for a fund, BSU.
- Possibly a *savings transaction* type, used to move money into the distribution and to record funds waiting to go to targets.

## 9. UI

**Desktop:** side menu. **Mobile:** bottom tabs `Overview · Transactions · (+ New) · Budget & Reporting · Settings`, with sub-menus instead of listing every screen.

| Screen | Content |
| ------ | ------- |
| Dashboard | Customisable widgets: budget health, bucket status, account balances, recent transactions, graphs… |
| Create transaction | INC, EXP, TRF, INP |
| Buckets | CAF/TF per bucket, drill into transactions, manual refill button |
| Bucket setup | Create/edit (name, importance, priority, options)/delete buckets. **Adjust:** *Temporary* (set TF, may exceed BC → BUA) · *Future* (set RA, BC follows its rules, TF unchanged) · *Both* (set RA and change TF by the same relative amount → BUA). The same options are available for reallocating between buckets (→ BAT). |
| Budget setup | All buckets at once: enter the expected monthly income per source account, set RAs, see the % allocated and the remainder |
| Accounts | Balances, drill into transactions, balance adjustment (BLA) |
| Account setup | Create/manage bank accounts |
| Transactions | Filter by account, bucket, cycle…; corrections and reversals |
| Savings | Expected deposits per savings target. "Done" creates the transfers |
| Savings setup | Savings targets and priority rules |
| Stats & reports | Spending and balance graphs over time; yearly PDF report; filter by bucket, tag, counterparty |
| Settings | Password, preferences, data export/import |
| Admin | User management, including password reset |

Which screen sits under which mobile tab still has to be decided in a design session.

## 10. Roadmap

**MVP:** users/auth, bank accounts, transactions (OPB, BLA, INC, EXP, TRF + bucket types), corrections, cycles, buckets, refill/overflow, allocation routine, core screens, deployment.

**Post-MVP:** scheduled & recurring transactions (auto-apply or approval queue with a due date), internal payments, multi-currency, stats & reports, savings module, dashboard widgets, data export/import.

## 11. Open questions & future ideas

- What exactly counts as an "On income" refill trigger? (e.g. a flag on the income transaction, or any income to the source account)
- Credit card transactions.
- Basic spending analysis (e.g. warnings to slow down in a category).
- Better investment tracking.
- Shared budgeting for couples (shared "Groceries" bucket, separate "Hobby" buckets). Note: the owner-embedded IDs assume a single owner.
- Recovering the admin password if it is forgotten.
- Which stats and reports to offer.

## 12. Dev rules

- The REST API must be documented (OpenAPI spec).
- Work on branches. `main` is only changed through pull requests.
