# Local install notes

Operational notes for this fork's install. `CLAUDE.local.md` points here.

## After a local commit

A local commit moves HEAD past `data/upgrade-state.json`. The next restart then fails on the upgrade tripwire, and the circuit breaker retries every 15 minutes. All agents stay silent.

After each local commit, do the build or image work that the commit needs. Then run `pnpm exec tsx scripts/upgrade-state.ts set` before the next restart. If all agents go silent, first look for `Upgrade tripwire` in `logs/nanoclaw.error.log`.

This install's names are slug-scoped, so the `com.nanoclaw` and `nanoclaw-agent:latest` in `CLAUDE.md` do not exist here:

- Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-89818148`
- Agent image: `nanoclaw-agent-v2-89818148:latest`

A change to `container/agent-runner/src/` needs no image rebuild: containers mount that source read-only and use it at the next spawn.

## OneCLI gateway version

The gateway runs exactly the pin in `.claude/skills/add-onecli/versions.json` (1.42.0). `~/.onecli/.env` holds `ONECLI_VERSION=1.42.0`. Keep that line: the compose file uses `latest` when it is missing, and `latest` moved this install to 1.45.0 once.

1.45.0 drops OneCLI agent groups in migration `20260727035117_drop_agent_groups`, so 1.42.0 cannot start on a 1.45 database (`policy_rule_identities.agent_group_id does not exist`). `~/.onecli/backups/reverse-drop-agent-groups.sql` recreates the dropped objects with the 1.42.0 DDL. To downgrade: stop NanoClaw and the `onecli` container, take a `pg_dump`, apply that file with `docker compose exec -T postgres psql`, set the pin, and run `docker compose up -d`.

Rollback to 1.45.0: set `ONECLI_VERSION=rollback` (a local tag of image `d0177458b1f9`) and run `docker compose up -d`. 1.45.0 applies its drop migration again. Dump from just before the downgrade: `~/onecli-db-backup-20261028-002451-pre-downgrade.sql`.

## New agent group (OneCLI)

If no OneCLI agent exists, OneCLI creates the group's agent on the first message, with no credential grants. The agent then gets 401 from `api.anthropic.com`.

Before the first message, create the agent yourself. The host finds it by identifier at spawn, so no restart is necessary:

1. Find the Anthropic secret ID: `onecli agents grants list --id <working-agent-id>`.
2. Create the agent: `onecli agents create --name <name> --identifier <agent-group-id>`. Keep only the `id` field of the output.
3. Attach the Anthropic secret and each service secret the group needs: `onecli agents grants attach-secret --id <new-agent-id> --secret-id <secret-id>`.

If the first message already came and the agent gets 401, do steps 1 and 3 for the agent that OneCLI created. Then run `ncl groups restart --id <group-id>`. The container reads its gateway config at spawn, so the grant alone is not sufficient.

`onecli agents list` prints access tokens. Do not repeat them. `onecli run … curl` from the host is not a valid credential test.

To prove that the gateway injects a token, send one request with no token and one with the placeholder token. Both must return 401, and the agent's request to the same endpoint must succeed. A service's "last used" display can update late, so do not use it as the test.

## Pulse capability manifest

`/api/agent/capabilities` returns about 66 KB of JSON and needs no token. To list each tool with its scope and mode in one call:

```bash
curl -s -m 10 http://<pulse-host>:7655/api/agent/capabilities | jq -r '.capabilities[] | "\(.name) \(.scope) \(.actionMode)"'
```
