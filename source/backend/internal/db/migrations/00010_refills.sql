-- Refills (spec §6). An income can trigger the refill of its account's
-- "On income" buckets; the header records that it does. Corrections copy the
-- flag like the counterparty, so the newest header of a family holds the
-- effective value. Adding a column doesn't fire the immutability triggers.
--
-- refills records each bucket's refill per cycle, so a bucket is refilled at
-- most once per cycle, and links the REF and OVF it recorded to the income
-- that triggered it, so reversing the income can undo them.

-- +goose Up
ALTER TABLE transaction_headers
    ADD COLUMN triggers_refill boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT transaction_headers_triggers_refill_check
        CHECK (NOT triggers_refill OR transaction_type = 'INC');

CREATE TABLE refills (
    bucket_id  text NOT NULL,
    cycle_id   text NOT NULL,
    user_id    text NOT NULL REFERENCES users (id),
    -- How the refill was triggered.
    trigger    refill_mode NOT NULL,
    -- The REF and OVF, when the amounts weren't 0.
    ref_id     text,
    ovf_id     text,
    -- The income that triggered an "On income" refill.
    income_id  text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bucket_id, cycle_id),
    FOREIGN KEY (bucket_id, user_id) REFERENCES buckets (id, user_id),
    FOREIGN KEY (cycle_id, user_id) REFERENCES cycles (id, user_id),
    FOREIGN KEY (ref_id, user_id) REFERENCES transaction_headers (id, user_id),
    FOREIGN KEY (ovf_id, user_id) REFERENCES transaction_headers (id, user_id),
    FOREIGN KEY (income_id, user_id) REFERENCES transaction_headers (id, user_id),
    CHECK ((trigger = 'on_income') = (income_id IS NOT NULL))
);

CREATE INDEX refills_income_id_idx ON refills (income_id);
CREATE INDEX refills_cycle_id_idx ON refills (cycle_id);

-- +goose Down
DROP TABLE refills;
ALTER TABLE transaction_headers
    DROP CONSTRAINT transaction_headers_triggers_refill_check,
    DROP COLUMN triggers_refill;
