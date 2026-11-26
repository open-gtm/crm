# Backup and restore

What to back up, how to restore it, and how to check that a restore worked. The commands are for the Compose setup in this repository; with a managed Postgres the same four things need covering, with that service's own tools.

## What holds state

| What | Where | Lose it and |
|---|---|---|
| The database | The `pgdata` volume (database `hlcrm`) | Everything is gone: workspaces, records, members, keys, the audit log and, by default, the bytes of attached files |
| The master key and the other secrets | `.env` (`HLCRM_MASTER_KEY`, `MCP_SERVICE_SECRET`, the three database passwords) | Without `HLCRM_MASTER_KEY`, restricted field values, webhook and automation secrets, stored idempotent responses and files kept in S3 can't be decrypted. Nothing can recover them. The other secrets can be replaced: new database passwords are set in Postgres, and a new `MCP_SERVICE_SECRET` only needs both services restarted |
| Audit anchors | The `blobs` volume (`/data/blobs/audit-anchors/`) | The audit log is still there, but `audit-verify` fails for every workspace that had an anchor: the files are the copy the chain is checked against |
| Attached files, with `FILE_STORE=s3` only | Your bucket | The file rows remain and downloads fail |

The database backup does not contain the master key, and should not: a stolen backup alone then gives up no restricted value. Keep `.env` somewhere separate from the database backups (a password manager or a secrets store), and check that copy when you run a restore drill.

Everything except restricted fields is plain text in the database and in its backups: names, emails, phone numbers, activity text, event payloads. Encrypt the backups and the disk they are kept on.

## Back up

Run this on a schedule (daily is a reasonable start) and before every upgrade. The database copy is consistent on its own; it does not need the app stopped.

```sh
# The database, in Postgres's compressed format
docker compose exec -T postgres pg_dump -U postgres -Fc hlcrm > hlcrm-$(date +%F).dump

# The audit anchors
docker run --rm -v hl-crm-db_blobs:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/blobs-$(date +%F).tar.gz -C /data .
```

Run the two commands one after the other. The worker writes one anchor per workspace an hour, as a row in the database and a file in the volume; if one is written between the two commands, that pair of backups disagrees and verification fails after a restore (see [Check a restore](#check-a-restore)). The next scheduled pair will agree.

`hl-crm-db_blobs` is the volume's name under the default project name. `docker volume ls` shows it if you changed the name.

With `FILE_STORE=s3`, back the bucket up with your provider's tools (versioning, replication). Files are sealed with each workspace's key, so the bucket copy is useless without the database and the master key.

Copy the backups off the machine. A backup on the same disk as the database protects against a bad upgrade and nothing else.

## Restore

To a new machine, or to the same one after removing the old volumes. You need the repository at the version you were running (or newer), your `.env`, a database dump and the anchors archive.

```sh
# 1. Put .env back first. It must hold the same HLCRM_MASTER_KEY as when the backup was taken.

# 2. Start Postgres alone. On an empty volume this creates the two roles and an empty hlcrm database.
docker compose up -d postgres

# 3. Load the dump into the empty database.
docker compose exec -T postgres pg_restore -U postgres -d hlcrm --exit-on-error < hlcrm-2026-11-25.dump

# 4. Put the audit anchors back.
docker run --rm -v hl-crm-db_blobs:/data -v "$PWD":/backup alpine \
  tar xzf /backup/blobs-2026-11-25.tar.gz -C /data

# 5. Start everything. Migrations newer than the backup are applied before the API comes up.
docker compose up -d
```

Step 3 needs the database empty, which is why step 2 starts only Postgres: starting everything would run the migrations first, and the restore would then stop at the first table that already exists.

A plain SQL dump (`pg_dump` without `-Fc`, as earlier versions of the README showed) restores with `docker compose exec -T postgres psql -U postgres -d hlcrm -v ON_ERROR_STOP=1 < backup.sql` in place of step 3.

If the database passwords in `.env` differ from the ones the backup was taken with, nothing breaks: roles and their passwords belong to the Postgres server, not to the dump, and step 2 creates them from the current `.env`.

## Check a restore

```sh
docker compose run --rm api audit-verify
```

It walks every workspace's audit chain, compares it with the anchors in the database and with the anchor files, and prints one line per workspace. `OK` on every line and exit status 0 mean the audit log arrived whole and the anchors match it.

- `anchor at seq … is missing from write-once storage`: the anchors archive is older than the database dump, or was not restored. Restore a later archive.
- `write-once storage holds an anchor at seq … that the database does not`: the archive is newer than the dump. Restore the dump taken with it, or a later one.

Then sign in and open a record with a restricted field. If the value shows, the master key is the right one. `audit-verify` does not check this: it reads no encrypted value, so it passes with the wrong key.

## What a restore does not bring back

- Anything written after the backup. `pg_dump` is a point in time; for less loss than a day, use Postgres's continuous archiving (point-in-time recovery) or a managed Postgres that offers it.
- Sessions that expired, and OAuth connections whose refresh tokens were used after the backup: the client's newer token is unknown to the restored database, so the person approves the connection again.
- Webhook deliveries and automation runs made after the backup are not known to the restored database, and events still waiting at backup time are processed again. Receivers can see the same event twice; the delivery's `webhook-id` header is what to deduplicate on ([`docs/webhooks.md`](webhooks.md)).

## Drill

Restore to a spare machine or a second Compose project on a schedule (quarterly is common), run the checks above, and write down the date, the backup used and how long it took. A backup that has never been restored is a guess.

The steps on this page were run against the Postgres image this repository pins: a dump of a seeded workspace restored into an empty database, both in the compressed and in the plain format, the migrator found it up to date, and `audit-verify` passed as the app role. Moving the `blobs` volume with `tar` was not part of that run.
