-- The rest of the bank account (spec §2): its type, and rules on its name.
-- Currency was added in 00003 and can't change after creation (enforced by
-- the API: changing it would make the account's history wrong).

-- +goose Up
CREATE TYPE account_type AS ENUM ('usage', 'savings', 'bsu', 'fund', 'investment');

ALTER TABLE bank_accounts
    ADD COLUMN account_type account_type NOT NULL DEFAULT 'usage',
    ADD CONSTRAINT bank_accounts_name_check CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100);

-- Names are unique per user, ignoring case, among accounts that aren't deleted.
CREATE UNIQUE INDEX bank_accounts_user_name_key ON bank_accounts (user_id, lower(name)) WHERE NOT deleted;

-- +goose Down
DROP INDEX bank_accounts_user_name_key;
ALTER TABLE bank_accounts
    DROP CONSTRAINT bank_accounts_name_check,
    DROP COLUMN account_type;
DROP TYPE account_type;
