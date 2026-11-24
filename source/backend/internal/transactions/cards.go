package transactions

// Card debt held per account (#261, spec §2.2). Until a credit card's bill is
// paid, the money for its debt stays in the accounts that budgeted it, held
// there for the card:
//
//   - a purchase holds its bucket parts on the buckets' accounts and the rest
//     on the account chosen for it (the card's default account unless said
//     otherwise, or nowhere); a refund releases the same way;
//   - a cash advance holds the money on the account it went to;
//   - a payment clears the paying account's hold first, then releases holds
//     on other accounts, as chosen or what's held beyond what's still owed;
//   - a transfer between other accounts can carry held debt along.

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"

	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/balance"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/cards"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/db/sqlc"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/ledger"
	"github.com/aasulvva/Bucky-BudgetR/source/backend/internal/money"
)

// cardKey is a card and the account its debt is held on.
type cardKey struct{ card, account string }

// cardLines returns the card debt lines n should have in effect. cur is the
// transaction n corrects, or nil: what its family holds doesn't count as held
// by others.
func cardLines(ctx context.Context, tx pgx.Tx, userID string, n New, cur *Transaction) ([]ledger.CardLine, error) {
	q := sqlc.New(tx)
	from, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: n.AccountID, UserID: userID})
	if err != nil {
		return nil, fmt.Errorf("%w: account %s doesn't exist", ErrInvalid, n.AccountID)
	}
	var to sqlc.BankAccount
	if n.ToAccountID != "" {
		if to, err = q.GetAccount(ctx, sqlc.GetAccountParams{ID: n.ToAccountID, UserID: userID}); err != nil {
			return nil, fmt.Errorf("%w: account %s doesn't exist", ErrInvalid, n.ToAccountID)
		}
	}
	isCard := func(a sqlc.BankAccount) bool { return a.AccountType == sqlc.AccountTypeCreditCard }
	purchase := (n.Type == sqlc.TransactionTypeEXP || n.Type == sqlc.TransactionTypeINC) && isCard(from)
	payment := n.Type == sqlc.TransactionTypeTRF && isCard(to) && !isCard(from)
	carry := n.Type == sqlc.TransactionTypeTRF && !isCard(to) && !isCard(from)
	switch {
	case n.SetAsideOn != nil && !purchase:
		return nil, fmt.Errorf("%w: only a purchase or refund on a credit card is set aside", ErrInvalid)
	case len(n.Carry) > 0 && !carry:
		return nil, fmt.Errorf("%w: only a transfer between accounts that aren't credit cards carries card debt", ErrInvalid)
	case n.Release != nil && !payment:
		return nil, fmt.Errorf("%w: only a payment to a credit card releases card debt", ErrInvalid)
	}

	out := map[cardKey]decimal.Decimal{}
	add := func(card, account string, amount decimal.Decimal) {
		k := cardKey{card, account}
		out[k] = out[k].Add(amount)
	}
	switch {
	case purchase:
		if err := purchaseLines(ctx, q, userID, n, from, add); err != nil {
			return nil, err
		}
	case n.Type == sqlc.TransactionTypeTRF && isCard(from) && !isCard(to):
		// A cash advance: the money is held where it went.
		add(from.ID, to.ID, n.Amount)
	case payment, carry && len(n.Carry) > 0:
		held, err := heldWithout(ctx, tx, userID, cur)
		if err != nil {
			return nil, err
		}
		if payment {
			err = paymentLines(ctx, tx, userID, n, held, cur, add)
		} else {
			err = carryLines(n, held, add)
		}
		if err != nil {
			return nil, err
		}
	}

	keys := slices.SortedFunc(maps.Keys(out), func(a, b cardKey) int {
		return cmp.Or(cmp.Compare(a.card, b.card), cmp.Compare(a.account, b.account))
	})
	var lines []ledger.CardLine
	for _, k := range keys {
		if !out[k].IsZero() {
			lines = append(lines, ledger.CardLine{CardID: k.card, AccountID: k.account, Amount: out[k]})
		}
	}
	return lines, nil
}

// purchaseLines holds a card purchase's bucket parts on the buckets' accounts
// and the rest on SetAsideOn; a refund releases them.
func purchaseLines(ctx context.Context, q *sqlc.Queries, userID string, n New, card sqlc.BankAccount,
	add func(card, account string, amount decimal.Decimal)) error {
	sign := decimal.NewFromInt(1)
	if n.Type == sqlc.TransactionTypeINC {
		sign = sign.Neg()
	}
	rest := n.Amount
	if len(n.Buckets) > 0 {
		want := make([]string, len(n.Buckets))
		for i, b := range n.Buckets {
			want[i] = b.BucketID
		}
		rows, err := q.GetOwnedBuckets(ctx, sqlc.GetOwnedBucketsParams{Ids: want, UserID: userID})
		if err != nil {
			return err
		}
		for _, b := range n.Buckets {
			i := slices.IndexFunc(rows, func(r sqlc.GetOwnedBucketsRow) bool { return r.ID == b.BucketID })
			if i < 0 {
				return fmt.Errorf("%w: bucket %s doesn't exist", ErrInvalid, b.BucketID)
			}
			add(card.ID, rows[i].SourceAccountID, b.Amount.Mul(sign))
			rest = rest.Sub(b.Amount)
		}
	}
	on := card.CardDefaultAccountID.String
	if n.SetAsideOn != nil {
		on = *n.SetAsideOn
	}
	if on != "" {
		if err := checkHolder(ctx, q, userID, card, on); err != nil {
			return err
		}
		if rest.IsPositive() {
			add(card.ID, on, rest.Mul(sign))
		}
	}
	return nil
}

// checkHolder checks that card debt can be held on account id: a live account
// of the user's that isn't a card, in the card's currency.
func checkHolder(ctx context.Context, q *sqlc.Queries, userID string, card sqlc.BankAccount, id string) error {
	a, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: account %s doesn't exist", ErrInvalid, id)
	}
	if err != nil {
		return err
	}
	if a.AccountType == sqlc.AccountTypeCreditCard || a.Currency != card.Currency {
		return fmt.Errorf("%w: account %s", ledger.ErrCardLine, id)
	}
	return nil
}

// heldWithout returns what's held for each card per account, less what cur's
// family holds.
func heldWithout(ctx context.Context, db sqlc.DBTX, userID string, cur *Transaction) (map[cardKey]decimal.Decimal, error) {
	byAccount, err := balance.CardDebt(ctx, db, userID)
	if err != nil {
		return nil, err
	}
	held := map[cardKey]decimal.Decimal{}
	for account, cards := range byAccount {
		for card, amount := range cards {
			held[cardKey{card, account}] = amount
		}
	}
	if cur != nil {
		for _, l := range cur.CardLines {
			k := cardKey{l.CardID, l.AccountID}
			held[k] = held[k].Sub(l.Amount)
		}
	}
	return held, nil
}

// paymentLines clears the paying account's hold for the card, then releases
// holds on other accounts: those in n.Release, or what's held beyond what the
// card still owes after the payment, largest holds first.
func paymentLines(ctx context.Context, db sqlc.DBTX, userID string, n New, held map[cardKey]decimal.Decimal,
	cur *Transaction, add func(card, account string, amount decimal.Decimal)) error {
	card, payer := n.ToAccountID, n.AccountID
	clear := decimal.Min(n.Amount, decimal.Max(held[cardKey{card, payer}], decimal.Zero))
	add(card, payer, clear.Neg())
	excess := n.Amount.Sub(clear)

	if n.Release != nil {
		total := decimal.Zero
		seen := map[string]bool{}
		for _, r := range *n.Release {
			if err := positive("release amount", r.Amount); err != nil {
				return err
			}
			if r.AccountID == payer || r.AccountID == card || seen[r.AccountID] {
				return fmt.Errorf("%w: release card debt once per account, on accounts other than the paying one", ErrInvalid)
			}
			seen[r.AccountID] = true
			if h := held[cardKey{card, r.AccountID}]; r.Amount.GreaterThan(h) {
				return fmt.Errorf("%w: account %s holds %s for the card, less than %s", ErrInvalid,
					r.AccountID, decimal.Max(h, decimal.Zero).StringFixed(money.Places), r.Amount.StringFixed(money.Places))
			}
			total = total.Add(r.Amount)
			add(card, r.AccountID, r.Amount.Neg())
		}
		if total.GreaterThan(excess) {
			return fmt.Errorf("%w: the releases add up to %s, more than the %s the payment leaves after clearing the paying account's hold",
				ErrInvalid, total.StringFixed(money.Places), excess.StringFixed(money.Places))
		}
		return nil
	}

	bal, err := balance.Accounts(ctx, db, userID)
	if err != nil {
		return err
	}
	after := bal[card].Add(n.Amount)
	if cur != nil {
		for _, l := range cur.BankLines {
			if l.AccountID == card {
				after = after.Sub(l.Amount)
			}
		}
	}
	owed := decimal.Max(after.Neg(), decimal.Zero)
	for _, r := range autoRelease(card, payer, held, clear, excess, owed) {
		add(card, r.AccountID, r.Amount.Neg())
	}
	return nil
}

// autoRelease is what a payment releases on accounts other than payer when
// the user doesn't say: what the card's holds come to beyond owed (what it
// owes after the payment) once the payer's hold is cleared by clear, at most
// excess, from the largest holds first (ties by account ID).
func autoRelease(card, payer string, held map[cardKey]decimal.Decimal, clear, excess, owed decimal.Decimal) []AccountAmount {
	total := decimal.Zero
	var others []AccountAmount
	for k, h := range held {
		if k.card != card || !h.IsPositive() {
			continue
		}
		total = total.Add(h)
		if k.account != payer {
			others = append(others, AccountAmount{AccountID: k.account, Amount: h})
		}
	}
	left := decimal.Min(excess, total.Sub(clear).Sub(owed))
	slices.SortFunc(others, func(a, b AccountAmount) int {
		return cmp.Or(b.Amount.Cmp(a.Amount), cmp.Compare(a.AccountID, b.AccountID))
	})
	var out []AccountAmount
	for _, o := range others {
		if !left.IsPositive() {
			break
		}
		r := decimal.Min(o.Amount, left)
		out = append(out, AccountAmount{AccountID: o.AccountID, Amount: r})
		left = left.Sub(r)
	}
	return out
}

// carryLines moves the card debt in n.Carry from the transfer's source to its
// receiving account.
func carryLines(n New, held map[cardKey]decimal.Decimal, add func(card, account string, amount decimal.Decimal)) error {
	total := decimal.Zero
	seen := map[string]bool{}
	for _, c := range n.Carry {
		if err := positive("carried card debt", c.Amount); err != nil {
			return err
		}
		if seen[c.CardID] {
			return fmt.Errorf("%w: card %s is carried twice", ErrInvalid, c.CardID)
		}
		seen[c.CardID] = true
		if h := held[cardKey{c.CardID, n.AccountID}]; c.Amount.GreaterThan(h) {
			return fmt.Errorf("%w: account %s holds %s for card %s, less than %s", ErrInvalid, n.AccountID,
				decimal.Max(h, decimal.Zero).StringFixed(money.Places), c.CardID, c.Amount.StringFixed(money.Places))
		}
		total = total.Add(c.Amount)
		add(c.CardID, n.AccountID, c.Amount.Neg())
		add(c.CardID, n.ToAccountID, c.Amount)
	}
	if total.GreaterThan(n.Amount) {
		return fmt.Errorf("%w: the carried card debt adds up to %s, more than the amount %s",
			ErrInvalid, total.StringFixed(money.Places), n.Amount.StringFixed(money.Places))
	}
	return nil
}

// cardDiff returns the lines that turn have into want, per card and account,
// leaving out zeros.
func cardDiff(have []CardLine, want []ledger.CardLine) []ledger.CardLine {
	d := map[cardKey]decimal.Decimal{}
	for _, l := range want {
		k := cardKey{l.CardID, l.AccountID}
		d[k] = d[k].Add(l.Amount)
	}
	for _, l := range have {
		k := cardKey{l.CardID, l.AccountID}
		d[k] = d[k].Sub(l.Amount)
	}
	keys := slices.SortedFunc(maps.Keys(d), func(a, b cardKey) int {
		return cmp.Or(cmp.Compare(a.card, b.card), cmp.Compare(a.account, b.account))
	})
	var out []ledger.CardLine
	for _, k := range keys {
		if !d[k].IsZero() {
			out = append(out, ledger.CardLine{CardID: k.card, AccountID: k.account, Amount: d[k]})
		}
	}
	return out
}

// keepCardChoices fills in what c leaves out of want from what cur does now:
// where a purchase's rest is set aside, what a transfer carries, and, while
// a payment keeps its amount and accounts, what it releases.
func keepCardChoices(ctx context.Context, q *sqlc.Queries, userID string, cur Transaction, c Changes, want *New) error {
	want.SetAsideOn, want.Carry, want.Release = c.SetAsideOn, c.Carry, c.Release
	// A move records it again, as new.
	if cur.isMove(*want) {
		return nil
	}
	if len(cur.CardLines) == 0 {
		// A card purchase without any (from before #261, or set aside
		// nowhere) stays so.
		if c.SetAsideOn == nil && (cur.Type == sqlc.TransactionTypeEXP || cur.Type == sqlc.TransactionTypeINC) {
			a, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: want.AccountID, UserID: userID})
			if err == nil && a.AccountType == sqlc.AccountTypeCreditCard {
				none := ""
				want.SetAsideOn = &none
			}
		}
		return nil
	}
	switch cur.Type {
	case sqlc.TransactionTypeEXP, sqlc.TransactionTypeINC:
		if c.SetAsideOn != nil {
			return nil
		}
		// The rest is held where the lines aren't the buckets' parts.
		parts := map[string]decimal.Decimal{}
		if len(cur.BucketLines) > 0 {
			ids := make([]string, len(cur.BucketLines))
			for i, l := range cur.BucketLines {
				ids[i] = l.BucketID
			}
			rows, err := q.GetOwnedBuckets(ctx, sqlc.GetOwnedBucketsParams{Ids: ids, UserID: userID})
			if err != nil {
				return err
			}
			for _, l := range cur.BucketLines {
				if i := slices.IndexFunc(rows, func(r sqlc.GetOwnedBucketsRow) bool { return r.ID == l.BucketID }); i >= 0 {
					// A bucket line and its hold have opposite signs.
					parts[rows[i].SourceAccountID] = parts[rows[i].SourceAccountID].Sub(l.Amount)
				}
			}
		}
		on := ""
		for _, l := range cur.CardLines {
			if !l.Amount.Equal(parts[l.AccountID]) {
				on = l.AccountID
				break
			}
		}
		if on == "" {
			// Nothing outside buckets is held: keep it that way unless there
			// was no rest to hold.
			rest := cur.BankLines[0].Amount.Abs()
			for _, l := range cur.BucketLines {
				rest = rest.Sub(l.Amount.Abs())
			}
			if !rest.IsPositive() {
				return nil
			}
		}
		want.SetAsideOn = &on
	case sqlc.TransactionTypeTRF:
		var from string
		for _, l := range cur.BankLines {
			if l.Amount.IsNegative() {
				from = l.AccountID
			}
		}
		if c.Carry == nil && c.Release == nil {
			var carried []CardAmount
			var released []AccountAmount
			for _, l := range cur.CardLines {
				switch {
				case l.AccountID == from && l.Amount.IsNegative():
					carried = append(carried, CardAmount{CardID: l.CardID, Amount: l.Amount.Neg()})
				case l.AccountID != from && l.Amount.IsNegative():
					released = append(released, AccountAmount{AccountID: l.AccountID, Amount: l.Amount.Neg()})
				}
			}
			to, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: want.ToAccountID, UserID: userID})
			if err != nil {
				return nil //nolint:nilerr // cardLines says the account is gone
			}
			fromAcc, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: want.AccountID, UserID: userID})
			if err != nil {
				return nil //nolint:nilerr // as above
			}
			card := sqlc.AccountTypeCreditCard
			if to.AccountType == card && fromAcc.AccountType != card {
				// A payment keeps its releases only while it's the same payment.
				if !want.Amount.Equal(cur.BankLines[0].Amount.Abs()) {
					return nil
				}
				want.Release = &released
			} else if to.AccountType != card && fromAcc.AccountType != card {
				want.Carry = carried
			}
		}
	}
	return nil
}

// ErrNotEnoughHeld means less is held on the account for the card than a
// release asks for (#261).
var ErrNotEnoughHeld = errors.New("less is held on the account for the card")

// SetAsideCardDebt holds amount of the card's debt that isn't held anywhere
// on the account (#261), out of its unallocated money: a CDH. It's refused
// above what isn't held (ErrInvalid) or above what's unallocated
// (ErrNotEnoughUnallocated).
func (s *Service) SetAsideCardDebt(ctx context.Context, userID, cardID, accountID string, amount decimal.Decimal) (Transaction, error) {
	return s.cardDebt(ctx, userID, cardID, accountID, amount, true)
}

// ReleaseCardDebt releases amount of what's held on the account for the card
// (#261), so it's unallocated again: a CDR. It's refused above what's held
// (ErrNotEnoughHeld).
func (s *Service) ReleaseCardDebt(ctx context.Context, userID, cardID, accountID string, amount decimal.Decimal) (Transaction, error) {
	return s.cardDebt(ctx, userID, cardID, accountID, amount, false)
}

func (s *Service) cardDebt(ctx context.Context, userID, cardID, accountID string, amount decimal.Decimal, hold bool) (Transaction, error) {
	if err := positive("amount", amount); err != nil {
		return Transaction{}, err
	}
	var out Transaction
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if err := ledger.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		q := sqlc.New(tx)
		card, err := q.GetAccount(ctx, sqlc.GetAccountParams{ID: cardID, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: account %s", ErrNotFound, cardID)
		}
		if err != nil {
			return err
		}
		if card.AccountType != sqlc.AccountTypeCreditCard {
			return fmt.Errorf("%w: account %s isn't a credit card", ErrInvalid, cardID)
		}
		if err := checkHolder(ctx, q, userID, card, accountID); err != nil {
			return err
		}
		m, err := balance.AccountMoney(ctx, tx, userID)
		if err != nil {
			return err
		}
		held := m[accountID].CardHolds[cardID]
		e := ledger.Entry{UserID: userID, CreatedBy: userID, At: s.now()}
		if hold {
			if _, _, free := cards.Holds(cardID, m); amount.GreaterThan(free) {
				return fmt.Errorf("%w: only %s of the card's debt isn't set aside", ErrInvalid, free.StringFixed(money.Places))
			}
			if free := m[accountID].Unallocated; amount.GreaterThan(free) {
				return fmt.Errorf("%w: the account has only %s unallocated", ErrNotEnoughUnallocated,
					decimal.Max(free, decimal.Zero).StringFixed(money.Places))
			}
			e.Type = sqlc.TransactionTypeCDH
			e.CardLines = []ledger.CardLine{{CardID: cardID, AccountID: accountID, Amount: amount}}
		} else {
			if amount.GreaterThan(held) {
				return fmt.Errorf("%w: only %s is held", ErrNotEnoughHeld, decimal.Max(held, decimal.Zero).StringFixed(money.Places))
			}
			e.Type = sqlc.TransactionTypeCDR
			e.CardLines = []ledger.CardLine{{CardID: cardID, AccountID: accountID, Amount: amount.Neg()}}
		}
		t, err := s.ledger.Record(ctx, tx, e)
		if err != nil {
			return err
		}
		out = merge([]sqlc.TransactionHeader{t.Header}, t.BankLines, t.BucketLines, t.SavingsLines, t.CardLines, t.WaitingLines, t.Tags, false)
		return nil
	})
	if err != nil {
		return Transaction{}, err
	}
	return out, nil
}
