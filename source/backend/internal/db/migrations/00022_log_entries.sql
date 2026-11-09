-- The log entries the app keeps for the Logs screen (#93): warnings and
-- errors (kind 'log'), app events ('event') and admin actions ('audit').
-- Ordinary request lines stay in the stdout log only. level is slog's
-- (-4 debug, 0 info, 4 warn, 8 error). user_id is the acting user, without a
-- foreign key so that an entry is never refused.

-- +goose Up
CREATE TABLE log_entries (
    id         bigserial PRIMARY KEY,
    at         timestamptz NOT NULL,
    level      smallint NOT NULL,
    kind       text NOT NULL CHECK (kind IN ('log', 'event', 'audit')),
    message    text NOT NULL,
    event      text,
    request_id text,
    user_id    text,
    attrs      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attrs) = 'object')
);

CREATE INDEX log_entries_at_idx ON log_entries (at);
CREATE INDEX log_entries_request_id_idx ON log_entries (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX log_entries_kind_idx ON log_entries (kind, id);

-- How long entries are kept, in days, set on the Logs screen. One row.
CREATE TABLE log_settings (
    id         boolean PRIMARY KEY DEFAULT true CHECK (id),
    event_days integer NOT NULL DEFAULT 30 CHECK (event_days BETWEEN 1 AND 3650),
    error_days integer NOT NULL DEFAULT 90 CHECK (error_days BETWEEN 1 AND 3650),
    audit_days integer NOT NULL DEFAULT 365 CHECK (audit_days BETWEEN 1 AND 3650)
);

INSERT INTO log_settings DEFAULT VALUES;

-- +goose Down
DROP TABLE log_settings;
DROP TABLE log_entries;
