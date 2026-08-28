# NanoClaw Multi-Agent Deployment Guide

Target environment:

```text
Intel Mac
  ↓ migration
Apple Silicon Mac
  ↓
NanoClaw v2
  ↓
Discord
  ├── #research  → Research Agent
  ├── #summary   → Summary Agent
  └── #coding    → Coding Agent

All Agents
  ↓ MCP
Nowledge Mem
```

---

## 0. Final Goal

The completed Discord server:

```text
AI Server

#research
    ↓
Research Agent
    ↓
Web + Nowledge

#summary
    ↓
Summary Agent
    ↓
Nowledge

#coding
    ↓
Coding Agent
    ↓
Git + Shell + Nowledge
```

Three independent agents:

```text
Research
├── CLAUDE.md
├── workspace
├── skills
├── model
└── session

Summary
├── CLAUDE.md
├── workspace
├── skills
├── model
└── session

Coding
├── CLAUDE.md
├── workspace
├── skills
├── model
└── session
```

Long-term memory:

```text
Nowledge Mem
```

Shared via MCP.

---

## 1. Make a Backup of NanoClaw on the Intel Mac

Go into the existing NanoClaw install:

```bash
cd ~/nanoclaw
```

Check the version:

```bash
git status
git remote -v
git log -1 --oneline
```

Check the data:

```bash
ls -lah data
ls -lah groups
```

If this exists:

```text
data/v2.db
```

it means the install already uses the NanoClaw v2 data structure.

Stop NanoClaw:

```bash
launchctl list | grep -i nanoclaw
```

Stop the service according to the actual plist.

Then make a backup:

```bash
cd ~

tar czf nanoclaw-data-backup.tar.gz \
  nanoclaw/data \
  nanoclaw/groups
```

If `.env` still has configuration worth keeping:

```bash
cp ~/nanoclaw/.env ~/nanoclaw-env-backup
```

Do not commit `.env` to Git.

---

## 2. Save Your Own NanoClaw Customizations

If NanoClaw already has your own Git fork:

```bash
cd ~/nanoclaw

git status
git branch
git remote -v
```

Commit the changes worth keeping:

```bash
git add <files to save>
git commit -m "Save NanoClaw customization before ARM migration"
git push
```

Do not commit:

```text
.env
credentials
data/
sessions
runtime files
```

---

## 3. Prepare the Environment on the ARM Mac

Check:

```bash
uname -m
```

You should see:

```text
arm64
```

Install base tools:

```bash
brew install git node pnpm
```

Check:

```bash
node --version
pnpm --version
git --version
```

Install Docker Desktop.

Check:

```bash
docker version
docker info
```

Check the Docker architecture:

```bash
docker run --rm alpine uname -m
```

You should get:

```text
aarch64
```

---

## 4. Clone NanoClaw

If you have your own fork:

```bash
cd ~

git clone <YOUR-NANOCLAW-FORK>
cd nanoclaw
```

If not:

```bash
git clone https://github.com/nanocoai/nanoclaw.git
cd nanoclaw
```

Install NanoClaw:

```bash
bash nanoclaw.sh
```

Do not restore the old data yet.

Check that the new NanoClaw runs correctly:

```bash
docker ps
```

and:

```bash
git status
```

---

## 5. Restore the Old NanoClaw Data

Transfer:

```text
nanoclaw-data-backup.tar.gz
```

to the ARM Mac.

Stop NanoClaw. Then:

```bash
cd ~

tar xzf nanoclaw-data-backup.tar.gz
```

Check:

```bash
ls ~/nanoclaw/data
ls ~/nanoclaw/groups
```

Do not migrate:

```text
node_modules/
Docker images
build/
dist/
Intel native binaries
```

Rebuild these on the ARM Mac.

---

## 6. Configure Discord

In the Discord Developer Portal, create:

```text
NanoClaw Bot
```

Enable:

```text
MESSAGE CONTENT INTENT
```

Invite the bot to your own Discord server.

Suggested server layout:

```text
AI

#inbox
#research
#summary
#coding
#automation
#agent-log
```

For the first phase, configure only:

```text
#research
#summary
#coding
```

---

## 7. Install the Discord Channel for NanoClaw

In the NanoClaw Claude Code environment, run:

```text
/add-discord
```

Follow the skill prompts to configure:

```text
Discord Bot Token
Server
Channel
Owner
```

Restart NanoClaw after you finish this step.

Test:

```text
#research

@NanoClaw hello
```

Confirm the full Discord → NanoClaw → Discord round trip works.

Complete this test before you create more agents.

---

## 8. Create the Research Agent

Create an independent agent group:

```text
research
```

Target:

```text
Agent ID:
research

Workspace:
groups/research/
```

Suggested `CLAUDE.md` for the Research Agent:

```markdown
# Research Agent

You are a research agent.

## Responsibilities

- Search the web for facts.
- Compare more than one trusted source.
- Check important claims.
- Use primary sources and official documents first.
- Keep facts and assumptions separate.
- Search Nowledge Mem first. Do not repeat past research.
- Save important findings and decisions to Nowledge Mem.

## Do not

- Do not change code without a request from a user.
- Do not run shell commands that delete or damage data.
- Do not send messages outside this system without approval.

## Output

Use this order in your answer:

1. Conclusion
2. Key findings
3. Evidence
4. Uncertainty
5. Recommended next action
```

The Research Agent needs:

```text
Web
MCP
Nowledge Mem
```

Do not grant it, initially:

```text
SSH
personal filesystem
unrestricted Git
```

---

## 9. Create the Summary Agent

Create:

```text
summary
```

Workspace:

```text
groups/summary/
```

`CLAUDE.md`:

```markdown
# Summary Agent

You are a summarization agent.

## Responsibilities

- Summarize existing information.
- Search Nowledge Mem for context.
- Combine related findings.
- Remove text that repeats.
- Keep all important numbers, dates, decisions, and warnings.
- Write short daily, weekly, project, and research summaries.

## Research

Do research only when a user asks for it.

If information is missing, say so. Do not guess.

## Output

Use this order in your answer:

1. Executive summary
2. Important findings
3. Decisions
4. Open questions
5. Next actions
```

The Summary Agent mainly needs:

```text
Nowledge MCP
read-only files
```

It does not need, by default:

```text
Shell
SSH
Git push
```

---

## 10. Create the Coding Agent

Create:

```text
coding
```

Workspace:

```text
groups/coding/
```

`CLAUDE.md`:

```markdown
# Coding Agent

You are a software engineering agent.

## Responsibilities

- Inspect the repository first. Then change the code.
- Learn the current design of the code.
- Make small changes.
- Run the correct tests.
- Review the git diff first. Then commit the change.
- Search Nowledge Mem for past decisions about the code design.

## Safety

- Do not change repositories outside the mounted paths.
- Never show a credential value in your output.
- Do not push code to Git unless a user allows it.
- Do not run Git commands that delete history or files.

## Workflow

1. Understand
2. Inspect
3. Plan
4. Modify
5. Test
6. Review diff
7. Report
```

Mount only the specified projects:

```text
~/projects/project-a
~/projects/project-b
```

Do not mount directly:

```text
~
```

---

## 11. Connect Nowledge Mem

Confirm Nowledge Mem is running.

Test:

```bash
curl http://127.0.0.1:14242/mcp/
```

Nowledge Mem's standard MCP endpoint:

```text
http://127.0.0.1:14242/mcp/
```

Add this to each agent's MCP configuration in NanoClaw:

```json
{
  "mcpServers": {
    "nowledge-mem": {
      "url": "http://127.0.0.1:14242/mcp/",
      "type": "streamableHttp"
    }
  }
}
```

Note:

Nowledge Mem often runs on the macOS host. The agent runs inside a Linux container. Inside the container, this address:

```text
127.0.0.1
```

refers to the container itself, not the host.

The NanoClaw container must reach Nowledge Mem on the host.

Docker Desktop usually uses:

```text
host.docker.internal
```

Inside the NanoClaw agent, use this address instead:

```json
{
  "mcpServers": {
    "nowledge-mem": {
      "url": "http://host.docker.internal:14242/mcp/",
      "type": "streamableHttp"
    }
  }
}
```

Test from the container first:

```bash
curl http://host.docker.internal:14242/mcp/
```

Confirm the connection first. Then add the MCP entry.

---

## 12. Give Each Agent an Independent Nowledge Identity

Suggested:

```text
Research Agent
NMEM_AGENT_ID=research

Summary Agent
NMEM_AGENT_ID=summary

Coding Agent
NMEM_AGENT_ID=coding
```

This way, Nowledge can distinguish:

```text
Who produced this memory?
```

while all agents still access the same:

```text
Nowledge Mem
```

forming:

```text
                 Nowledge Mem
                      │
       ┌──────────────┼──────────────┐
       │              │              │
   research        summary         coding
       │              │              │
       ▼              ▼              ▼
 Research Agent  Summary Agent  Coding Agent
```

---

## 13. Discord Channel → Agent Wiring

Now connect each channel to its agent:

```text
#research
    ↓
research

#summary
    ↓
summary

#coding
    ↓
coding
```

Use NanoClaw's:

```text
/manage-channels
```

to wire each Discord messaging group to the corresponding agent group.

Recommended session mode:

```text
per-thread
```

so:

```text
#research
   │
   ├── Thread: NanoClaw
   │       ↓
   │    Session A
   │
   ├── Thread: Apple Container
   │       ↓
   │    Session B
   │
   └── Thread: nanobot
           ↓
        Session C
```

but all three sessions belong to:

```text
research agent group
```

and therefore share:

```text
CLAUDE.md
skills
workspace
```

The agents share long-term knowledge through Nowledge Mem instead.

---

## 14. First Round of Testing

### Test 1: Research

In Discord:

```text
#research

Research NanoClaw's current Apple Container support.
Use official sources where possible.
Save durable findings to Nowledge.
```

Verify:

```text
Discord
   ↓
Research Agent
   ↓
Web
   ↓
Nowledge save
```

### Test 2: Summary

In Discord:

```text
#summary

Search Nowledge for our NanoClaw and Apple Container research.

Give me a concise summary of the current situation.
```

Do not provide the original Research conversation here.

If the Summary Agent can find it from Nowledge:

```text
Research Agent
       ↓
Nowledge
       ↓
Summary Agent
```

this confirms that shared memory works correctly.

---

## 15. Test the Coding Agent

In Discord:

```text
#coding

Inspect project-a.

Tell me:
- current branch
- git status
- project structure
- how tests are run

Do not modify anything.
```

Confirm the Coding Agent:

can see:

```text
project-a
```

cannot see:

```text
~/Documents
~/Downloads
other repositories
```

Then test one small change to a real file.

---

## 16. Test Agent Isolation

Research Agent:

```text
List the source repositories you can access.
```

Should be:

```text
unable to access Coding Agent repositories
```

Summary Agent:

```text
Run git status on project-a.
```

Should be:

```text
no permission
```

Coding Agent:

```text
Search Nowledge for our previous NanoClaw architecture decision.
```

Should be:

```text
allowed
```

Target:

```text
             Shared
               │
        ┌──────▼──────┐
        │ Nowledge Mem│
        └──────┬──────┘
               │
      ┌────────┼────────┐
      │        │        │
 Research   Summary   Coding
      │        │        │
 isolated   isolated  isolated
 workspace  workspace workspace
```

---

## 17. Phase Two: Agent-to-Agent

Wait until phase one is stable. Then enable:

```text
Research → Summary
```

Target workflow:

```text
User
 │
 ▼
Research Agent
 │
 ├── research
 ├── verify
 ├── save Nowledge
 │
 └── message
       │
       ▼
 Summary Agent
       │
       ├── retrieve
       ├── summarize
       │
       ▼
    Discord
```

Open only:

```text
research
    ↓
summary
```

first. Do not allow all agents to message each other from the start.

---

## 18. Phase Three: Main Agent

Create the Main Agent only after the first three agents are stable:

```text
main
```

The Main Agent does not do most of the work itself.

It mainly does this:

```text
Understand request
       ↓
Choose Agent
       ↓
Delegate
       ↓
Monitor
       ↓
Return result
```

Final structure:

```text
                     User
                      │
                      ▼
                  Main Agent
                      │
          ┌───────────┼───────────┐
          │           │           │
          ▼           ▼           ▼
      Research     Summary      Coding
       Agent        Agent        Agent
          │           │           │
          └───────────┼───────────┘
                      │
                      ▼
                Nowledge Mem
```

---

## 19. Recommended Rollout Order

Do not build all features at once.

### Phase 1

```text
ARM Mac
↓
NanoClaw
↓
Discord
```

Confirm basic operation.

### Phase 2

```text
Research Agent
↓
#research
```

Run only one agent.

### Phase 3

Connect:

```text
Nowledge MCP
```

Test:

```text
Research → save
Research → retrieve
```

### Phase 4

Add:

```text
Summary Agent
```

Test:

```text
Research
   ↓
Nowledge
   ↓
Summary
```

### Phase 5

Add:

```text
Coding Agent
```

Limit filesystem mounts to only the needed paths.

### Phase 6

Configure:

```text
Agent-to-Agent
```

### Phase 7

Add last:

```text
Main Agent
```

---

## Final Structure

```text
                       Discord
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
     #research        #summary         #coding
          │               │               │
          ▼               ▼               ▼
      Research         Summary          Coding
       Agent            Agent            Agent
          │               │               │
          │               │               │
          └───────────────┼───────────────┘
                          │
                         MCP
                          │
                          ▼
                    Nowledge Mem
                          │
                   Shared Memory
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
     Claude Code         Codex         NanoClaw
```

## Core Principles

```text
Discord
= Interface

NanoClaw
= Multi-Agent Runtime

Agent Group
= Role + Workspace + Permissions

Discord Thread
= Short-term Context

Nowledge Mem
= Long-term Shared Memory

MCP
= Memory Interface

Git
= Project Knowledge

Container
= Security Boundary
```

Build first:

```text
Research
+
Summary
```

Confirm this works:

```text
Research
   ↓
Nowledge
   ↓
Summary
```

Then add Coding and Main Agent later.
