-- An optional description of what a transaction was (#130), up to 500
-- characters and possibly several lines. Like the counterparty it belongs to
-- the header, so a correction can change it; the newest header of a family
-- holds the effective one. Schedules have one too, copied to each
-- transaction they record.

-- +goose Up
ALTER TABLE transaction_headers
    ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 500);
ALTER TABLE schedules
    ADD COLUMN description text NOT NULL DEFAULT '' CHECK (length(description) <= 500);

-- +goose Down
ALTER TABLE schedules DROP COLUMN description;
ALTER TABLE transaction_headers DROP COLUMN description;
