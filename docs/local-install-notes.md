# Local install notes

Operational notes for this fork's install. `CLAUDE.local.md` points here.

## After a local commit

A local commit moves HEAD past `data/upgrade-state.json`. The next restart then fails on the upgrade tripwire, and the circuit breaker retries every 15 minutes. All agents stay silent.

After each local commit, do the build or image work that the commit needs. Then run `pnpm exec tsx scripts/upgrade-state.ts set` before the next restart. If all agents go silent, first look for `Upgrade tripwire` in `logs/nanoclaw.error.log`.

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
