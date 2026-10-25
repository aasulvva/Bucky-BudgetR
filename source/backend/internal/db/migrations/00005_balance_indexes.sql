-- Balances and TF are sums over ledger lines (spec §2). Covering indexes let
-- PostgreSQL sum an account's or bucket's lines from the index alone.

-- +goose Up
DROP INDEX bank_transactions_account_id_idx;
CREATE INDEX bank_transactions_account_id_idx ON bank_transactions (account_id) INCLUDE (amount, transaction_id);
DROP INDEX bucket_transactions_bucket_id_idx;
CREATE INDEX bucket_transactions_bucket_id_idx ON bucket_transactions (bucket_id, cycle_id) INCLUDE (amount, transaction_id);

-- +goose Down
DROP INDEX bucket_transactions_bucket_id_idx;
CREATE INDEX bucket_transactions_bucket_id_idx ON bucket_transactions (bucket_id);
DROP INDEX bank_transactions_account_id_idx;
CREATE INDEX bank_transactions_account_id_idx ON bank_transactions (account_id);
