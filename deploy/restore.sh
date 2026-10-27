#!/usr/bin/env bash
# Restores a dump made by backup.sh (docs/DEPLOYMENT.md). Run on the host,
# from anywhere; FILE is the dump's path on the host.
#
#   ./restore.sh --check FILE   restore drill: restore FILE into a scratch
#                               database, compare it with the live one, and
#                               drop it again. Changes nothing.
#   ./restore.sh FILE           replace the app's database with FILE. Backs
#                               up the current data first and asks before.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
	echo "usage: $0 [--check] FILE" >&2
	exit 2
}
check=false
if [[ ${1:-} == --check ]]; then
	check=true
	shift
fi
[[ $# -eq 1 ]] || usage
file=$1
[[ -f $file ]] || {
	echo "no such file: $file" >&2
	exit 1
}

# Runs a shell script in the db container, where the POSTGRES_* variables
# are set.
db() { docker compose exec -T -e PGOPTIONS=--client-min-messages=warning db sh -c "$1"; }

# The app's database, expanded in the container.
# shellcheck disable=SC2016
live='"$POSTGRES_DB"'

counts() {
	db "psql -U \"\$POSTGRES_USER\" -d $1 -At -F ' ' -c \"
		SELECT 'schema_version', max(version_id)::text FROM goose_db_version
		UNION ALL SELECT 'users', count(*)::text FROM users
		UNION ALL SELECT 'bank_accounts', count(*)::text FROM bank_accounts
		UNION ALL SELECT 'buckets', count(*)::text FROM buckets
		UNION ALL SELECT 'cycles', count(*)::text FROM cycles
		UNION ALL SELECT 'transactions', count(*)::text FROM transaction_headers
		UNION ALL SELECT 'last_transaction', coalesce(max(created_at)::date::text, '-') FROM transaction_headers\""
}

if $check; then
	scratch=bucky_restore_check
	db "dropdb -U \"\$POSTGRES_USER\" --if-exists $scratch && createdb -U \"\$POSTGRES_USER\" $scratch"
	trap 'db "dropdb -U \"\$POSTGRES_USER\" --if-exists $scratch"' EXIT
	db "pg_restore -U \"\$POSTGRES_USER\" -d $scratch --no-owner --exit-on-error" <"$file"
	restored=$(counts $scratch | sort)
	current=$(counts "$live" | sort)
	echo "Restored $file into a scratch database. Backup vs. live database:"
	join -a 1 -a 2 -e - -o 0,1.2,2.2 <(echo "$restored") <(echo "$current") |
		awk 'BEGIN { printf "%-18s %-12s %s\n", "", "backup", "live" } { printf "%-18s %-12s %s\n", $1, $2, $3 }'
	echo "The restore works. The scratch database is dropped again."
	exit 0
fi

echo "This replaces ALL data in the app's database with:"
echo "  $file"
read -r -p "Type 'restore' to go on: " answer
[[ $answer == restore ]] || {
	echo "Nothing changed."
	exit 1
}

echo "Backing up the current data first…"
docker compose exec -T backup sh /usr/local/bin/backup.sh now pre-restore
docker compose stop app
db "dropdb -U \"\$POSTGRES_USER\" --force \"\$POSTGRES_DB\" && createdb -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\""
db "pg_restore -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" --no-owner --exit-on-error" <"$file"
docker compose up -d --wait app
echo "Restored. The app is running again on the restored data:"
counts "$live"
