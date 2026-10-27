#!/bin/sh
# Database backups for deploy/compose.yaml (docs/DEPLOYMENT.md). Runs in the
# backup container, which sets the PG* connection variables and mounts the
# backup folder at /backups:
#   daily/    one dump a day, after BACKUP_TIME (local time, TZ)
#   weekly/   the first daily dump of each week
#   monthly/  the first daily dump of each month
#   manual/   dumps made with `now`, e.g. before an update; never deleted
# Weekly and monthly dumps are hard links to the daily ones, so they take no
# extra space. Each folder keeps the newest KEEP_DAILY, KEEP_WEEKLY and
# KEEP_MONTHLY dumps. Every dump is checked with pg_restore --list before it
# is kept.
#
# Usage: backup.sh daemon        check every 5 minutes, back up when due
#        backup.sh now [LABEL]   one dump in manual/ now; prints its path
#        backup.sh health        exit 0 if backups are working
set -eu

DIR=/backups
STATUS=$DIR/.status
BACKUP_TIME=${BACKUP_TIME:-03:00}
KEEP_DAILY=${KEEP_DAILY:-14}
KEEP_WEEKLY=${KEEP_WEEKLY:-8}
KEEP_MONTHLY=${KEEP_MONTHLY:-12}

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# dump FOLDER NAME writes FOLDER/NAME.dump and prints its path. A dump that
# fails or doesn't read back is removed.
dump() {
	mkdir -p "$1"
	tmp="$1/.$2.dump.partial"
	if pg_dump --format=custom --file="$tmp" && pg_restore --list "$tmp" >/dev/null; then
		mv "$tmp" "$1/$2.dump" && echo "$1/$2.dump"
	else
		rm -f "$tmp"
		return 1
	fi
}

# prune FOLDER KEEP deletes all but the newest KEEP dumps. Names sort by
# time, and so do globs.
prune() {
	n=0
	for f in "$1"/*.dump; do
		[ -e "$f" ] && n=$((n + 1))
	done
	for f in "$1"/*.dump; do
		[ "$n" -gt "$2" ] || break
		rm -f "$f"
		n=$((n - 1))
	done
}

stamp() { date -u +%Y-%m-%dT%H%M%SZ; }

daily() {
	if ! file=$(dump "$DIR/daily" "bucky-$(stamp)"); then
		echo "failed $(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATUS"
		log "backup FAILED; retrying in 5 minutes"
		return 1
	fi
	# The first dump of a week and of a month is kept longer, even when the
	# machine was off on the Sunday or the 1st.
	week=$(date +%G-W%V)
	if [ "$(cat "$DIR/.last-weekly" 2>/dev/null || true)" != "$week" ]; then
		mkdir -p "$DIR/weekly" && ln -f "$file" "$DIR/weekly/" && echo "$week" >"$DIR/.last-weekly"
	fi
	month=$(date +%Y-%m)
	if [ "$(cat "$DIR/.last-monthly" 2>/dev/null || true)" != "$month" ]; then
		mkdir -p "$DIR/monthly" && ln -f "$file" "$DIR/monthly/" && echo "$month" >"$DIR/.last-monthly"
	fi
	prune "$DIR/daily" "$KEEP_DAILY"
	prune "$DIR/weekly" "$KEEP_WEEKLY"
	prune "$DIR/monthly" "$KEEP_MONTHLY"
	date +%Y-%m-%d >"$DIR/.last-daily"
	echo "ok $(date -u +%Y-%m-%dT%H:%M:%SZ) ${file#"$DIR"/}" >"$STATUS"
	log "backed up to ${file#"$DIR"/} ($(du -h "$file" | cut -f1))"
}

# due: no daily dump today yet, and it's BACKUP_TIME or later. A missed run
# (the machine was off) is caught up as soon as possible.
due() {
	[ "$(cat "$DIR/.last-daily" 2>/dev/null || true)" != "$(date +%Y-%m-%d)" ] &&
		[ "$(expr "$(date +%H:%M)" \>= "$BACKUP_TIME")" = 1 ]
}

case "${1:-daemon}" in
daemon)
	trap 'exit 0' TERM INT
	[ -f "$STATUS" ] || echo "waiting" >"$STATUS"
	log "daily backups after $BACKUP_TIME ($(date +%Z)); keeping $KEEP_DAILY daily, $KEEP_WEEKLY weekly, $KEEP_MONTHLY monthly"
	while :; do
		if due; then daily || true; fi
		sleep 300 &
		wait $!
	done
	;;
now)
	label=${2:-manual}
	case "$label" in *[!A-Za-z0-9_-]*)
		echo "LABEL: use letters, digits, - and _" >&2
		exit 2
		;;
	esac
	file=$(dump "$DIR/manual" "bucky-$(stamp)-$label")
	log "backed up to ${file#"$DIR"/}"
	;;
health)
	read -r state _ <"$STATUS" || exit 1
	[ "$state" = ok ] || [ "$state" = waiting ] || exit 1
	newest=
	for f in "$DIR"/daily/*.dump; do
		[ -e "$f" ] && newest=$f
	done
	# Healthy until the first dump; then the newest must be under 26 hours old.
	[ -z "$newest" ] || [ -n "$(find "$newest" -mmin -1560)" ]
	;;
*)
	echo "usage: backup.sh daemon | now [LABEL] | health" >&2
	exit 2
	;;
esac
