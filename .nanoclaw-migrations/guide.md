# NanoClaw Migration Guide

Generated: 2026-09-27
Base: 294ef2aee85218b23ad30eda9dfe10e590b54a8c
HEAD at generation: ab438454b264ceaf3d6eefd31e7ea94655ac7d36
Upstream: b200712e53e514515fd68a153e58ab287971aeab

Tier: 2 (moderate — 3 skills, 5 custom pieces, 1 post-upgrade data step)

## Applied Skills

Reapply each by re-running its own `/add-<name>` apply against the clean upstream base.

- `add-discord` — owns `src/channels/discord.ts`, `src/channels/discord-registration.test.ts`; appends `import './discord.js';` to `src/channels/index.ts`. Modified afterwards — see "Modifications to Applied Skills".
- `add-dashboard` — owns `src/dashboard-pusher.ts`, `src/dashboard-pusher.test.ts`, `src/dashboard-wiring.test.ts`, and the `startDashboard()` block in `main()` of `src/index.ts` (its step 3). No manual changes on top.
- `add-onecli` — **new upstream in 2.4.0**, required: the host refuses to start without a registered gateway. Apply it unmodified (see "Dropped customizations").

## Skill Interactions

- `add-discord` and the thread-titling customization: `thread-titling.ts` calls `setThreadTitle` through `channel-registry`; Discord implements it via `renameDiscordThread`. Reapply `add-discord` first, then its modification, then thread-titling.

## Modifications to Applied Skills

### add-discord: rename threads (`setThreadTitle`)

**Intent:** Let the thread-titling hook rename Discord threads.

**Files:** `src/channels/discord.ts`, `src/channels/discord-registration.test.ts`

**How to apply:**

1. In `src/channels/discord.ts`, add after `unwrapForwardedSnapshot`:
   ```typescript
   /**
    * `threadId` is the Chat SDK's compound form (`discord:{guild}:{channel}:{thread}`);
    * Discord's REST API wants only the trailing snowflake. Threads are channels for
    * rename purposes: `PATCH /channels/{id}` with `{ name }`. A 3-part id means no
    * thread exists — renaming would hit the parent channel, so skip silently.
    */
   export async function renameDiscordThread(botToken: string, threadId: string, title: string): Promise<void> {
     const parts = threadId.split(':');
     if (parts.length < 4) return;
     const id = parts[parts.length - 1];
     const res = await fetch(`https://discord.com/api/v10/channels/${id}`, {
       method: 'PATCH',
       headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
       body: JSON.stringify({ name: title }),
     });
     if (!res.ok) {
       throw new Error(`Discord thread rename failed: ${res.status} ${await res.text()}`);
     }
   }
   ```
2. In the `registerChannelAdapter('discord', …)` factory, change `return createChatSdkBridge({...});` to:
   ```typescript
   const bridge = createChatSdkBridge({ /* unchanged options */ });
   bridge.setThreadTitle = (_platformId, threadId, title) =>
     renameDiscordThread(env.DISCORD_BOT_TOKEN!, threadId, title);
   return bridge;
   ```
3. Role mentions: in `#summary`, Discord autocomplete offers only the bot's managed role `@Puppet Master`, not the bot user. The adapter counts a role mention only when the role ID is in `mentionRoleIds`. It otherwise reads `process.env.DISCORD_MENTION_ROLE_IDS`, which the service never loads from `.env`. In the factory, add `'DISCORD_MENTION_ROLE_IDS'` to the `readEnvFile([...])` keys and pass this to `createDiscordAdapter({...})`:
   ```typescript
   mentionRoleIds: env.DISCORD_MENTION_ROLE_IDS?.split(',')
     .map((id) => id.trim())
     .filter(Boolean),
   ```
   `.env` holds `DISCORD_MENTION_ROLE_IDS=1476488874388750339` (data, not code, so the migration keeps it).
4. In `src/channels/discord-registration.test.ts`: import `vi, afterEach` from vitest and `renameDiscordThread` from `./discord.js`, then copy the `describe('renameDiscordThread', …)` block from the main tree (`git show ab438454:src/channels/discord-registration.test.ts`). It has two tests: a 3-part id makes no fetch, and a 4-part id PATCHes `https://discord.com/api/v10/channels/thread1`.

## Customizations

### Auto-title new platform threads

**Intent:** A new Discord thread gets its title from the message that created it, not `Thread <date>`. A link-only message gets the page title (YouTube via oEmbed, else `<title>` or `og:title`, with entities decoded and the ` — Site` suffix dropped). Any failure falls back to the message text.

**Files:** `src/thread-titling.ts`, `src/thread-titling.test.ts` (new), `src/index.ts`

**How to apply:**

1. Copy both files verbatim from the main tree: `git show ab438454:src/thread-titling.ts` and `git show ab438454:src/thread-titling.test.ts`. They use only upstream seams that exist at `b200712e`: `setThreadTitle` (`src/channels/channel-registry.ts`), `registerSessionCreatedHook` and `SessionCreatedEvent` (`src/router.ts`, fields `session`, `mg`, `platformId`, `threadId`, `message.content`), and `log`.
2. In `src/index.ts`, after `import './modules/index.js';`, add:
   ```typescript
   // Registers a session-created hook that auto-titles new platform threads.
   // Imported for side effects.
   import './thread-titling.js';
   ```

### Delivery retry backoff, held per destination

**Intent:** A network blip must not discard a reply. Upstream retries at poll speed (1 s), so 3 attempts burn in about 3 s. Use 7 attempts with exponential backoff (5 s, 10 s … 160 s, about 5 min in total). A message that waits for a retry holds only the rest of **its own** destination stream, so the order within a conversation stays correct and other destinations keep draining.

**Files:** `src/delivery.ts`, `src/delivery.test.ts`

**Upstream changed this area — do not copy the old code.** At `b200712e`, attempt counts are in the central-DB `delivery_attempts` table (`src/db/coordination.ts`: `recordDeliveryAttempt({ messageId, sessionId, now, nextAttemptAt, error })` returns the new count, and `getDeliveryAttempt(id)` returns a row with `attempts` and `next_attempt_at`). `delivery.ts` wraps these in `recordAttemptRow` and `clearAttemptRow` and always passes `nextAttemptAt: null`. Port the intent onto that table:

1. Set `MAX_DELIVERY_ATTEMPTS = 7` and add `const BACKOFF_BASE_MS = 5_000;`, with a comment that it uses the same name and idiom as the stale-message backoff in `host-sweep.ts`.
2. Add:
   ```typescript
   /** The conversation a message belongs to; messages on different streams are independent. */
   function destinationStream(msg: { channelType: string | null; platformId: string | null; threadId: string | null }) {
     return JSON.stringify([msg.channelType, msg.platformId, msg.threadId]);
   }
   ```
3. Give `recordAttemptRow` a `nextAttemptAt: string | null` parameter and pass it through (instead of `null`).
4. In `drainSession`, before `for (const msg of pending)`, add `const heldStreams = new Set<string>();`. At the top of the loop body:
   ```typescript
   const stream = destinationStream(msg);
   if (heldStreams.has(stream)) continue;
   const prior = await getDeliveryAttempt(msg.id).catch(() => undefined); // bookkeeping must never break delivery
   if (prior?.next_attempt_at && Date.parse(prior.next_attempt_at) > Date.now()) {
     heldStreams.add(stream);
     continue;
   }
   ```
5. In the `catch (err)`, compute the backoff from the prior count before you record the attempt:
   ```typescript
   const backoffMs = BACKOFF_BASE_MS * Math.pow(2, prior?.attempts ?? 0);
   const attempts = await recordAttemptRow(msg.id, session.id, err, new Date(Date.now() + backoffMs).toISOString());
   ```
   In the "will retry" branch, add `backoffMs` to the log fields and add `heldStreams.add(stream);`.
6. Tests in `src/delivery.test.ts`: cover (a) no retry before `next_attempt_at`, (b) the backoff schedule 5 s → 160 s over 7 attempts, (c) a held message blocks later messages on the same stream but not on other streams. Use the fork's old tests as a reference (`git show ab438454:src/delivery.test.ts`), but adapt them to the DB-backed counter.
7. Upstream's own attempt tests assume one retry per tick and 3 attempts. Adapt them: in `src/delivery-attempts-authority.test.ts`, seed 6 prior attempts (7 of 7 overall). In `src/delivery-shadow.test.ts`, use fake timers to wait out each backoff (5s…160s) and expect 6 attempts before the seventh clears the row.
8. `src/startup-order.test.ts` mocks every startup dependency of `src/index.ts`. Add `vi.mock('./thread-titling.js', () => ({}));` and `vi.mock('./dashboard-pusher.js', () => ({ startDashboard: vi.fn() }));`. Without the first mock, the router mock has no `registerSessionCreatedHook`. Without the second, the real dashboard import sometimes keeps the vitest worker alive.
9. Add the CHANGELOG `[Unreleased]` entries for this item, thread titling, and the research skill (copy them from `git show ab438454:CHANGELOG.md`).

### Run task pre-scripts as Node ES modules when detected

**Intent:** Pre-scripts with `import`/`export` syntax or a node shebang run with `node`. Other scripts still run with `bash`.

**Files:** `container/agent-runner/src/scheduling/task-script.ts`, `container/agent-runner/src/scheduling/task-script.test.ts`

**How to apply:**

1. Add after the existing interfaces:
   ```typescript
   export interface ScriptRuntime {
     command: string;
     extension: string;
     args: (scriptPath: string) => string[];
   }

   export function selectScriptRuntime(script: string): ScriptRuntime {
     const trimmed = script.trimStart();
     const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
     if (firstLine.startsWith('#!') && (firstLine.includes('/node') || firstLine.includes('env node'))) {
       return nodeRuntime;
     }
     if (/^(import|export)\s/.test(trimmed)) {
       return nodeRuntime;
     }
     return bashRuntime;
   }

   const bashRuntime: ScriptRuntime = { command: 'bash', extension: 'sh', args: (scriptPath) => [scriptPath] };
   const nodeRuntime: ScriptRuntime = { command: 'node', extension: 'mjs', args: (scriptPath) => [scriptPath] };
   ```
2. In `runScript`, upstream's signature is now `runScript(script, taskId, timeoutMs = SCRIPT_TIMEOUT_MS)`. Keep that signature. Replace only the path and the command:
   ```typescript
   const runtime = selectScriptRuntime(script);
   const scriptPath = path.join('/tmp', `task-script-${taskId}.${runtime.extension}`);
   ...
   execFile(runtime.command, runtime.args(scriptPath), { timeout: timeoutMs, maxBuffer: SCRIPT_MAX_BUFFER, env: process.env }, /* unchanged callback */);
   ```
3. **Do not overwrite** upstream's `task-script.test.ts`, because it has its own script-skip and timeout tests. Add `selectScriptRuntime` to its import from `./task-script.js`. Then append a `describe('selectScriptRuntime', …)` block with three `bun:test` cases: shell → `bash`/`sh`; `import …` → `node`/`mjs`; `#!/usr/bin/env node` → `node`/`mjs`.

### `research` container skill

**Intent:** A container skill that researches a question against primary sources and writes the cited findings to one Markdown file.

**Files:** `container/skills/research/SKILL.md` (new; upstream has no file at this path)

**How to apply:** Copy it as-is from the main tree.

### Multi-agent Discord deployment guide (docs)

**Files:** `docs/multi-agent-deployment-guide.md` (new, docs only)

**How to apply:** Copy it as-is from the main tree.

### `.gitignore` local-file entries

**How to apply:** Append:
```
.codegraph/
HANDOFF.md
SHELLOUT-VERDICT.md
```

## Dropped customizations

- **OneCLI `g-` identifier prefix** (`src/onecli-identifier.ts` and its use in the OneCLI spawn and approval paths): dropped by user decision. Upstream now creates every agent group id with an `ag-` prefix, so all new ids start with a letter. Do **not** copy `src/onecli-identifier.ts`. Apply `add-onecli` without changes.
- **Root `CLAUDE.md` OneCLI "Secret modes" edit** (commit `ab438454`): dropped. Upstream removed that section, and the OneCLI docs now come with `add-onecli`.

## Post-upgrade data step: recreate `researcher`

The only legacy group with a digit-leading id is `6e725851-24b8-489f-9b99-cb73fcce902f` (folder `researcher`). OneCLI knows it as `g-6e725851-…`. Without the patch, OneCLI rejects its raw id and the group cannot spawn. After the upgraded host runs, recreate the group with an `ag-` id. Use `ncl <resource> help` for the exact flags.

Its state at generation:

- Folder `groups/researcher/` (CLAUDE.md, CLAUDE.local.md, memory/, plugins/, package.json). Reuse the folder; upstream `ncl groups create` supports folder reuse.
- Container config: skills `"all"`, MCP server `nowledge-mem` = `{"type":"http","url":"https://now.kang.is:8442/mcp/"}`, npm package `@steipete/summarize`, cli_scope `group`.
- Wiring: messaging group `mg-1779894370684-odlw6m`, session_mode `shared`, engage `mention-sticky`, sender_scope `known`, ignored-message policy `accumulate`. The wiring creates the destination (`discord-mg-17798`).
- Member: `discord:954039493852299374`.

Steps:

1. Create a new group on folder `researcher`, then reapply the container config, the wiring, and the member above.
2. Delete the old wiring and the old group `6e725851-…`.
3. OneCLI: `onecli agents grants list --id <old g- agent id>`. Attach the same secrets to the new `ag-…` agent with `onecli agents grants attach-secret`, then delete the old `g-6e725851-…` agent.
4. Send a test mention in the Discord channel.
