# infra

Docker, deploy, and runbooks. The root `docker-compose.yml` is the single stack definition for local and
Linode; the two differ only in `.env` versus Docker secrets.

- `linode-runbook.md`: production provisioning steps (A.7). Written before the live cutover, not before.
