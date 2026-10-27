# Deployment

How to run Bucky BudgetR for real on a home server. It is reached over HTTPS from the LAN and, if you like, over the tailnet (Tailscale clients on a Headscale server). Everything runs in Docker Compose from the `deploy/` folder:

| Service  | What it does |
| -------- | ------------ |
| `app`    | The Go server, with the frontend embedded. Runs migrations on start. Not reachable from outside. |
| `db`     | PostgreSQL 18. Its data is in the `db-data` volume. |
| `caddy`  | HTTPS with your certificate, on the host's LAN address (and tailnet address) only, ports 443 (and 80, which redirects). |
| `backup` | A database dump every day, kept in a folder on the host with rotation. |

The app and the database sit on an internal Docker network with no way in or out except through Caddy.

This is financial data: **set up backups, and copy them off the machine, before you rely on it.**

## Requirements

- A Linux host (amd64) with Docker Engine and the Compose plugin.
- A fixed LAN address for the host (a DHCP reservation in the router, or set on the host).
- For the tailnet: the Tailscale client on the host, logged in to your Headscale (`tailscale up --login-server …`).
- A TLS certificate and key (PEM) for the names or addresses you'll use (see [Names or addresses](#names-or-addresses)), e.g. from your own CA. Every device that opens the app must trust it.
- A clone of this repository on the host. The image is built there from the source.

## First install

1. **Clone** the repository, e.g. to `/opt/bucky-budgetr`, and `cd deploy`.
2. **Choose the address** you'll type in the browser: a name, or the IP addresses (see [Names or addresses](#names-or-addresses)). Set up the DNS records if you use a name.
3. **Put the certificate in place**, e.g. `/etc/bucky-budgetr/tls/cert.pem` (with any intermediate certificates appended) and `key.pem`. Caddy runs as root in its container, so `root:root` with mode `600` on the key is fine.
4. **Create the backup folder** outside Docker's volumes, owned by the user who should own the dumps:
   ```bash
   sudo mkdir -p /srv/bucky-budgetr/backups && sudo chown "$(id -u):$(id -g)" /srv/bucky-budgetr/backups
   ```
5. **Configure:** `cp .env.example .env`, then fill in `.env`. The file explains each setting. At least set:
   - `COMPOSE_FILE`: keep `compose.yaml:compose.tailnet.yaml` for the LAN and the tailnet, or set `compose.yaml` for the [LAN only](#lan-only);
   - `POSTGRES_PASSWORD`: letters and digits only, e.g. `openssl rand -hex 24`;
   - `BUCKY_HOSTNAMES`, `LAN_ADDR`, and `TAILNET_ADDR` with the tailnet;
   - the certificate location;
   - `BUCKY_INITIAL_ADMIN_PASSWORD`;
   - the backup settings.

   Keep `.env` private (`chmod 600 .env`); it holds the database password.
6. **With the tailnet, start Docker after Tailscale.** Caddy listens on the tailnet address, which exists only once `tailscaled` is up. After a reboot, Docker must wait for it:
   ```bash
   sudo systemctl edit docker.service
   # add:
   # [Unit]
   # After=tailscaled.service
   # Wants=tailscaled.service
   ```
7. **Start:**
   ```bash
   BUCKY_VERSION=$(git describe --tags --always) docker compose up -d --build --wait
   ```
   The first build takes a few minutes. `--wait` returns once every service is healthy.
8. **Log in** at `https://<your name or address>` as `admin` with `BUCKY_INITIAL_ADMIN_PASSWORD`. You must choose a new password. Then:
   - create the other users under **Admin**;
   - check that the first backup appears (see [Backups](#backups)).

If you use a firewall on the host, allow TCP 80 and 443 on the LAN (and tailnet) interfaces. Docker publishes the ports only on `LAN_ADDR` (and `TAILNET_ADDR`), so nothing listens on any other address.

## Names or addresses

The certificate must cover exactly what you type in the browser, and the browser only checks that. `BUCKY_HOSTNAMES` lists the same names or addresses, comma-separated. Pick one way:

### One name on both networks (recommended)

One name, such as `bucky.home.example`, that each network resolves to the host's address there (split DNS). The certificate needs just that name, and the app has one address everywhere, so a phone that moves between Wi-Fi and the tailnet stays logged in.

- **LAN:** in your router or LAN DNS server (Pi-hole, …), point the name to the host's LAN address.
- **Tailnet:** in Headscale's config, add the name under `dns.extra_records` with the host's tailnet address (`tailscale ip -4`), then reload Headscale. Tailnet devices use Headscale's DNS (MagicDNS on), so they reach the host over the tailnet, at home or away:
  ```yaml
  dns:
    extra_records:
      - name: bucky.home.example
        type: A
        value: 100.64.0.10
  ```

```dotenv
BUCKY_HOSTNAMES=bucky.home.example
```

The certificate's SAN is `DNS:bucky.home.example`. Use a domain you own, or a name under `home.arpa`; avoid `.local`, which belongs to mDNS.

You can also use two names, one per network (e.g. the MagicDNS name Headscale gives the host on the tailnet). Put both in `BUCKY_HOSTNAMES`, and the certificate must cover both. Each name then has its own login.

### IP addresses, no DNS

The app is opened at `https://192.168.1.10` on the LAN and `https://100.64.0.10` on the tailnet, with no DNS to set up. The certificate holds the addresses as IP SANs:

```ini
# e.g. with your own CA, in the certificate request or its extensions:
subjectAltName = IP:192.168.1.10, IP:100.64.0.10
```

```dotenv
BUCKY_HOSTNAMES=192.168.1.10, 100.64.0.10
```

Browsers send no server name for an IP address, so Caddy picks the certificate as if they had asked for `LAN_ADDR`; that's why one certificate must hold both addresses. Some things to know:

- **Fixed addresses:** if the host's LAN address changes, you need a new certificate. Headscale keeps a node's tailnet address.
- **Two logins:** each address is its own site to the browser, so you log in once on each, and bookmarks differ by network.
- Leave out the tailnet address for the [LAN only](#lan-only).

### LAN only

To run without the tailnet, leave Tailscale out:

```dotenv
COMPOSE_FILE=compose.yaml
BUCKY_HOSTNAMES=bucky.home.example
LAN_ADDR=192.168.1.10
# no TAILNET_ADDR
```

`compose.tailnet.yaml` is what adds the tailnet address, so Caddy then listens on `LAN_ADDR` only. Use a name in your LAN DNS or the LAN address, as above, and skip the step that makes Docker wait for Tailscale. The app is then reachable at home only.

To add the tailnet later, set `COMPOSE_FILE=compose.yaml:compose.tailnet.yaml` and `TAILNET_ADDR`, add the name or address to the certificate and `BUCKY_HOSTNAMES`, make Docker wait for Tailscale, and run `docker compose up -d --wait` (then `docker compose restart caddy` if you changed the certificate).

## Everyday commands

Run these in `deploy/`.

```bash
docker compose ps                    # status and health of each service
docker compose logs -f app           # the app's log (JSON, one line per request)
docker compose logs backup           # when backups ran, and their size
docker compose restart app           # restart one service
docker compose down                  # stop everything (the data stays)
```

## Updating

```bash
./update.sh
```

This does four things:
1. backs up the database to `manual/…-pre-update.dump`;
2. runs `git pull --ff-only`;
3. rebuilds the image;
4. restarts with `docker compose up -d --wait`.

The app applies new migrations when it starts. Its first log line says the version it runs (`"msg":"starting","version":…`).

### Rolling back

Migrations only go forward, so going back means older code and the data from before the update:

1. `git log` to find the commit you were on before, then `git checkout <commit>`.
2. `BUCKY_VERSION=$(git describe --tags --always) docker compose up -d --build --wait`. The older app may refuse to start on the newer schema; that's fine, the next step replaces it.
3. Restore the `pre-update` dump (see [Restoring](#restoring)).
4. Later, `git checkout main` returns to the normal update path.

## Backups

The `backup` service runs `deploy/backup.sh`. Once a day after `BACKUP_TIME` (in the `TZ` time zone) it writes a `pg_dump` (custom format) to `BACKUP_DIR`:

```
daily/bucky-2026-10-27T020001Z.dump     the newest KEEP_DAILY (14) days
weekly/…                                the first dump of each week, the newest KEEP_WEEKLY (8)
monthly/…                               the first dump of each month, the newest KEEP_MONTHLY (12)
manual/…-pre-update.dump                made by update.sh and restore.sh, or by hand; never deleted
```

- **How they're checked:** each dump is read back with `pg_restore --list` before it is kept.
- **Space:** weekly and monthly dumps are hard links to the daily ones, so they take no extra space.
- **Missed runs:** if the host was off at backup time, the backup runs as soon as it is back.
- **Health:** the service is *unhealthy* in `docker compose ps` if the last backup failed or the newest daily dump is more than 26 hours old. Times in file names are UTC.

**Back up now**, e.g. before changing something by hand:

```bash
docker compose exec backup sh /usr/local/bin/backup.sh now my-label
```

Clean up `manual/` yourself now and then.

### Off the machine

A backup on the same disk doesn't survive a disk failure or a theft. Copy `BACKUP_DIR` elsewhere regularly. Some options:
- **A NAS or another computer:** a nightly `rsync -a --delete /srv/bucky-budgetr/backups/ nas:/backups/bucky/` from cron or a systemd timer, after `BACKUP_TIME`. `--delete` mirrors the rotation; leave it out to keep everything.
- **Cloud storage:** [rclone](https://rclone.org) `sync` to a remote. Use an rclone `crypt` remote, or encrypt the dumps first (e.g. with `age`), because the dumps hold all your financial data in readable form.
- **Syncthing** to another device you own.

Whatever you choose, run the restore drill on a copy from that place now and then.

## Restoring

`deploy/restore.sh` runs on the host and reads a dump from any path.

**The restore drill** changes nothing. Do it after setting up, and then every few months:

```bash
./restore.sh --check /srv/bucky-budgetr/backups/daily/bucky-2026-10-27T020001Z.dump
```

It restores the dump into a scratch database, prints the schema version and the counts of users, accounts, buckets, cycles and transactions next to the live ones, and drops the scratch database again.

**A real restore** replaces all data with the dump:

```bash
./restore.sh /srv/bucky-budgetr/backups/daily/bucky-2026-10-27T020001Z.dump
```

It asks you to type `restore`, then:
1. backs up the current data to `manual/…-pre-restore.dump`;
2. stops the app;
3. recreates the database from the dump;
4. starts the app again.

Sessions come back from the dump too, so users may need to log in again.

## Certificate renewal

Replace the files in `TLS_CERT_DIR`, then restart Caddy, which reads them on start (a few seconds without HTTPS):

```bash
docker compose restart caddy
```

(`caddy reload` is not enough: with the Caddyfile unchanged, it keeps the certificate it already loaded.)

Check the new expiry date with `openssl s_client -connect <your name or address>:443 </dev/null 2>/dev/null | openssl x509 -noout -enddate`.

## Locked out

If no admin can log in:

```bash
docker compose exec app bucky-server reset-password --user admin
```

It prints a temporary password, makes `admin` an active admin and ends their sessions. They choose a new password when they log in.

## Security notes

- Only Caddy is reachable, on the LAN address (and the tailnet address). The app, the database and the backup service have no published ports and no internet access.
- The app runs as a non-root user on a read-only filesystem with no capabilities. The image has only the binary, with no shell or package manager.
- Logins are rate limited per user and per client address. The app trusts Caddy's `X-Forwarded-For` (and nobody else's) for the client address.
- Session cookies are `Secure`, `HttpOnly` and `SameSite=Lax`, and HTTPS is required. Plain HTTP only redirects.
- Keep `deploy/.env`, the TLS key and the backups readable only by you.
