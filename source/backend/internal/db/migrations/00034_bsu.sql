-- BSU accounts (#214, spec §3): the deposit limits per year, and each BSU
-- account's history setup.

-- +goose Up
-- The limits by law, set by admins. A year uses the rule with the latest
-- from_year at or before it (the first rule for years before it).
CREATE TABLE bsu_rules (
    from_year    smallint PRIMARY KEY CHECK (from_year BETWEEN 2000 AND 2100),
    yearly_limit numeric(14,2) NOT NULL CHECK (yearly_limit > 0),
    total_limit  numeric(14,2) NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    modified_at  timestamptz NOT NULL DEFAULT now(),
    -- The admin who last changed it; not a foreign key, so deleting the
    -- user keeps the rule.
    updated_by   text,
    CHECK (total_limit >= yearly_limit)
);

-- Today's limits, from 2021 (Skatteetaten).
INSERT INTO bsu_rules (from_year, yearly_limit, total_limit) VALUES (2021, 27500, 300000);

-- A BSU account is locked until its history is set up (bsu_set_up_at);
-- bsu_opened_year is the year it was opened, as the setup gave it.
ALTER TABLE bank_accounts
    ADD COLUMN bsu_set_up_at timestamptz,
    ADD COLUMN bsu_opened_year smallint CHECK (bsu_opened_year BETWEEN 1900 AND 2100);

-- +goose Down
ALTER TABLE bank_accounts DROP COLUMN bsu_opened_year, DROP COLUMN bsu_set_up_at;
DROP TABLE bsu_rules;
