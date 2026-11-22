-- The savings distributor (#232, spec §8): its hold mode, and the rules it
-- splits money by. The distributor is the user's one savings holder of kind
-- 'distributor' (00026); what it holds are its savings lines, as for targets.
-- A split is an SVD: a savings line off the distributor and one per target (or
-- a bucket line, for a bucket target funded from the same account).

-- +goose Up
ALTER TABLE savings_holders
    -- When the distributor splits: as money comes in, once its holdings on an
    -- account reach min_amount, or only when asked.
    ADD COLUMN hold_mode  savings_hold_mode,
    ADD COLUMN min_amount numeric(14, 2) CHECK (min_amount > 0),
    DROP CONSTRAINT savings_holders_kind_check,
    ADD CONSTRAINT savings_holders_kind_check CHECK (
        (kind = 'target' AND (bucket_id IS NULL) <> (account_id IS NULL) AND goal IS NOT NULL
            AND hold_mode IS NULL AND min_amount IS NULL)
        OR (kind = 'distributor' AND bucket_id IS NULL AND account_id IS NULL AND goal IS NULL AND name IS NULL
            AND hold_mode IS NOT NULL AND (min_amount IS NOT NULL) = (hold_mode = 'minimum')));

-- A distributor rule: where a target stands (its balance or TF plus what's
-- held for it) from range_from up to, but not including, range_to (NULL: no
-- end), it takes a share by priority. One target's ranges don't overlap; the
-- service checks that.
CREATE TABLE savings_rules (
    id          text PRIMARY KEY CHECK (id ~ '^[1-9][0-9]{11}$'), -- ids.SavingsRule
    target_id   text NOT NULL,
    user_id     text NOT NULL REFERENCES users (id),
    range_from  numeric(14, 2) NOT NULL CHECK (range_from >= 0),
    range_to    numeric(14, 2) CHECK (range_to > range_from),
    priority    smallint NOT NULL CHECK (priority BETWEEN 0 AND 6),
    -- The rule may take the target past its goal.
    past_goal   boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    modified_at timestamptz NOT NULL DEFAULT now(),
    CHECK (left(id, 10) = target_id),
    FOREIGN KEY (target_id, user_id) REFERENCES savings_holders (id, user_id)
);

CREATE INDEX savings_rules_target_id_idx ON savings_rules (target_id);
CREATE INDEX savings_rules_user_id_idx ON savings_rules (user_id);

-- +goose Down
-- The distributor goes, and with it every transaction that touched it (its
-- SVR, SVC and SVD, their corrections and reversals), using the ledger's
-- delete switch (see 00023). What it held goes back to unallocated.
SELECT set_config('bucky.replacing_user_data', 'on', true);
CREATE TEMPORARY TABLE distributor_transactions ON COMMIT DROP AS
SELECT id FROM transaction_headers
WHERE transaction_type = 'SVD'
   OR id IN (SELECT l.transaction_id FROM savings_transactions l
             JOIN savings_holders h ON h.id = l.holder_id WHERE h.kind = 'distributor');
INSERT INTO distributor_transactions
SELECT id FROM transaction_headers WHERE parent_id IN (SELECT id FROM distributor_transactions);
DELETE FROM transaction_tags WHERE transaction_id IN (SELECT id FROM distributor_transactions);
DELETE FROM savings_transactions WHERE transaction_id IN (SELECT id FROM distributor_transactions);
DELETE FROM bucket_transactions WHERE transaction_id IN (SELECT id FROM distributor_transactions);
DELETE FROM bank_transactions WHERE transaction_id IN (SELECT id FROM distributor_transactions);
DELETE FROM transaction_headers WHERE parent_id IN (SELECT id FROM distributor_transactions);
DELETE FROM transaction_headers WHERE id IN (SELECT id FROM distributor_transactions);
SELECT set_config('bucky.replacing_user_data', 'off', true);
DROP TABLE savings_rules;
DELETE FROM savings_holders WHERE kind = 'distributor';
ALTER TABLE savings_holders
    DROP CONSTRAINT savings_holders_kind_check,
    DROP COLUMN hold_mode,
    DROP COLUMN min_amount,
    ADD CONSTRAINT savings_holders_kind_check CHECK (
        (kind = 'target' AND (bucket_id IS NULL) <> (account_id IS NULL) AND goal IS NOT NULL)
        OR (kind = 'distributor' AND bucket_id IS NULL AND account_id IS NULL AND goal IS NULL AND name IS NULL));
