-- +goose Up
-- What an overflow (OVF, #233) or savings budget SVR (#234) moved on at
-- once: the SVB straight into a bucket target funded from the account, and
-- the SVD when the distributor split it. Undoing the source takes these back
-- first, as far as the money is still held or in the bucket (spec §8.5).
CREATE TABLE savings_follow_ons (
    source_id  text NOT NULL,
    follow_id  text NOT NULL,
    user_id    text NOT NULL REFERENCES users (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, follow_id),
    FOREIGN KEY (source_id, user_id) REFERENCES transaction_headers (id, user_id),
    FOREIGN KEY (follow_id, user_id) REFERENCES transaction_headers (id, user_id)
);

CREATE INDEX savings_follow_ons_user_id_idx ON savings_follow_ons (user_id);
CREATE INDEX savings_follow_ons_follow_id_idx ON savings_follow_ons (follow_id);

-- +goose Down
DROP TABLE savings_follow_ons;
