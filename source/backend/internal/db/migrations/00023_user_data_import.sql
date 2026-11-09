-- Importing a user's data (#36) replaces it, ledger included. The ledger
-- stays immutable, except that a row may be deleted in a transaction that
-- has set bucky.replacing_user_data to 'on' (with SET LOCAL or
-- set_config(…, true)), which only internal/userdata does. Updates and
-- TRUNCATE are always refused.

-- +goose Up
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'
       AND current_setting('bucky.replacing_user_data', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is immutable: record a correction or reversal instead', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is immutable: record a correction or reversal instead', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;
-- +goose StatementEnd
