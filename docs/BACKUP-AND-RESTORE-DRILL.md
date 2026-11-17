# Backups: restore drill and encrypted off-server copies

The live service takes a verified backup every hour into `/var/lib/mansu-pos-live-trading/backups` and keeps 30 days there. Two gaps remain: no one has proved a backup can be restored, and copies that leave the server are not encrypted. This page closes both.

Each backup is a pair: `pos-live-….db` and `pos-live-….db.manifest.json`. Always keep the two together.

## 1. Restore drill (monthly, about 5 minutes)

The drill opens a **copy** of a backup in a private temporary folder and checks it: SQLite integrity, the manifest's checksum and ledger identity, and that every table the POS needs is present. It then prints what the backup contains. It never changes the backup, never touches the running POS and never replaces a ledger.

On the server:

```bash
cd /opt/mansu-pos-live-trading && node server/restore-drill.js "$(ls -1t /var/lib/mansu-pos-live-trading/backups/pos-live-*.db | head -1)"
```

On another computer (better: proves the backup works away from the server). Install Node.js 22, download the code, put the `.db` and its `.manifest.json` in one folder, then:

```bash
npm run restore-drill -- /path/to/pos-live-DATE.db
```

**Pass:** `RESTORE DRILL PASSED`, followed by the number of sales, the time of the last sale and the paid total. Compare the last sale with the POS Sales screen at the time the backup was taken.
**Fail:** `RESTORE DRILL FAILED: …` with the reason. Try the previous hour's backup and report the failure.

Record each drill in the log at the bottom of this page.

A full restore that *replaces* the live ledger is a different, rare operation (`npm run restore`, see [OPERATIONS.md](OPERATIONS.md#restore)) and should not be needed for a drill.

## 2. Encrypted off-server copy (weekly)

On the server:

```bash
bash /opt/mansu-pos-live-trading/deploy/export-backup.sh
```

It runs the restore drill on the newest backup, then packs the pair and encrypts it with a passphrase you type twice (GnuPG, AES-256). The passphrase is not stored anywhere. The result is in `/root/pos-exports/`.

Download it to your own computer, then delete the server copy:

```bash
scp root@YOUR_SERVER:/root/pos-exports/pos-live-DATE.tar.gpg .
```

```bash
ssh root@YOUR_SERVER 'rm /root/pos-exports/pos-live-*.tar.gpg'
```

Keep the passphrase in a password manager, separate from the file. Without it the copy cannot be opened. Keep at least the last 4 weekly copies, ideally on two places (for example your laptop and a cloud drive).

To open a copy later (Gpg4win on Windows, GnuPG on Mac/Linux):

```bash
gpg -d pos-live-DATE.tar.gpg | tar -x
```

Then run the restore drill on the extracted `.db` to confirm it.

Older unencrypted copies already downloaded should be replaced with encrypted ones and deleted.

## Recovery targets

| Target | Value today |
|---|---|
| Data you could lose (RPO) | Up to 1 hour (hourly backups); up to 1 week if the server itself is lost and only weekly off-server copies exist |
| Time to be selling again (RTO) | Not yet measured; record it during the first full drill on another machine |

WordPress and WooCommerce need their own backups (your host or a backup plugin). The POS backup does not include them.

## Drill log

| Date | Backup tested | Where | Result | By |
|---|---|---|---|---|
| | | | | |
