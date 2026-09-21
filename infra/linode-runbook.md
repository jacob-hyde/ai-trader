# Linode runbook (A.7)

Skeleton. Fill in when approaching the live cutover (EPIC-N).

1. Instance: size, region, image.
2. Base hardening: user, SSH keys only, firewall (only 22/80/443 in), automatic security updates.
3. Time: NTP sync verified. The trading clock runs in ET on top of a UTC host.
4. Docker + compose install.
5. Secrets: Docker secrets for Alpaca live keys, DB password, Anthropic key. No `.env` on the server.
   Rotate the engine's database role too: `ALTER ROLE trader_engine PASSWORD '<secret>'` (the dev
   default is the role name) and point `DATABASE_URL` at it.
6. Deploy flow: pull, `docker compose up -d`, health checks green.
7. Backups: nightly `pg_dump` to Linode Object Storage; restore drill.
8. Alerts: ntfy topic configured; watchdog verified by killing the engine once.
9. Cutover checklist: reconciliation on boot, panic endpoint reachable from a phone, EOD flatten observed once in paper on the server.
