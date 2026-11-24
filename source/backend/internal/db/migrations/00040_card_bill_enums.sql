-- Finalizing a card's bill (#262, spec §2.2): a statement can be fixed by
-- auto-finalize, and a scheduled bill payment that finds nothing left to pay
-- is skipped as paid. A new enum value can't be used in the transaction that
-- adds it, so the rest is in the next migration.

-- +goose Up
ALTER TYPE card_statement_fix ADD VALUE IF NOT EXISTS 'auto';
ALTER TYPE occurrence_reason ADD VALUE IF NOT EXISTS 'paid';

-- +goose Down
-- As in 00037, the values stay, unused: Up adds them only if they're missing.
SELECT 1;
