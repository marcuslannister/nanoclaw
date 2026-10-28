/**
 * Torn-read check for inbound.db across the Docker bind mount (issue #1).
 *
 * Host file locks do not reach the container on Docker Desktop, so a container
 * read can catch a host write half done ("database disk image is malformed",
 * "attempt to write a readonly database"). Probe 1 shows whether a host lock is
 * visible in the container. Probe 2 runs a host open-write-close loop against a
 * container poll loop and counts the read errors that persist.
 *
 *   REAL=1     poll with the real sqliteGetPendingMessages (retries torn reads)
 *   RETRIES=n  retry count for the plain-query reader (REAL unset)
 *   GAP_MS=n   pause between host writes (0 = no pause, extreme stress)
 *
 * Expected with REAL=1 GAP_MS=50: errs is {}. Without the readInbound retry it
 * shows thousands of errors.
 *
 * Usage: REAL=1 GAP_MS=50 pnpm exec tsx scripts/sanity-inbound-torn-read.ts [seconds] [image]
 * Requires: Docker running and a built agent image.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const seconds = Number(process.argv[2] ?? 10);
const image = process.argv[3] ?? 'nanoclaw-agent-v2-89818148:latest';
const dir = join('/tmp', `nanoclaw-i1-${Date.now()}`);
mkdirSync(dir, { recursive: true });
spawnSync('chmod', ['777', dir]);
const dbPath = join(dir, 'inbound.db');

const init = new Database(dbPath);
init.pragma('journal_mode = DELETE');
init.exec(`CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, status TEXT DEFAULT 'pending',
  process_after TEXT, content TEXT NOT NULL)`);
init.close();
const out = new Database(join(dir, 'outbound.db'));
out.exec('CREATE TABLE processing_ack (message_id TEXT PRIMARY KEY, status TEXT, status_changed TEXT)');
out.close();

function container(script: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('docker', [
      'run',
      '--rm',
      '-v',
      `${dir}:/workspace`,
      '-v',
      `${process.cwd()}/container/agent-runner/src:/ar/src:ro`,
      '--entrypoint',
      'bun',
      image,
      '-e',
      script,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', () => resolve(out.trim()));
  });
}

// Probe 1: does a host lock reach the container?
{
  const h = new Database(dbPath);
  h.exec('BEGIN EXCLUSIVE');
  const out = await container(`
    import { Database } from 'bun:sqlite';
    const db = new Database('/workspace/inbound.db', { readonly: true });
    db.exec('PRAGMA busy_timeout = 0');
    try { db.prepare('SELECT COUNT(*) n FROM messages_in').get(); console.log('LOCK_NOT_SEEN'); }
    catch (e) { console.log('LOCK_SEEN ' + e.message); }`);
  h.exec('ROLLBACK');
  h.close();
  console.log(`[probe-lock] ${out}`);
}

// Probe 2: stress — host open-write-close loop vs container poll loop.
const reader = container(`
  import { Database } from 'bun:sqlite';
  const end = Date.now() + ${seconds * 1000};
  const errs = {}; let ok = 0;
  const REAL = ${process.env.REAL === '1'};
  const { sqliteGetPendingMessages: getPending } = await import('/ar/src/mailbox/sqlite/operations.ts');
  const RETRIES = ${Number(process.env.RETRIES ?? 0)};
  while (Date.now() < end) {
    for (let attempt = 0; ; attempt++) try {
      const db = new Database('/workspace/inbound.db', { readonly: true });
      db.exec('PRAGMA busy_timeout = 5000'); db.exec('PRAGMA mmap_size = 0');
      try { REAL ? getPending(false, 10) : db.prepare("SELECT * FROM messages_in WHERE status = 'pending' ORDER BY seq LIMIT 10").all(); ok++; }
      finally { db.close(); }
      break;
    } catch (e) {
      if (attempt < RETRIES) { Bun.sleepSync(20); continue; }
      errs[e.message] = (errs[e.message] ?? 0) + 1; break;
    }
  }
  console.log(JSON.stringify({ ok, errs }));`);

await new Promise((r) => setTimeout(r, 1500)); // container start
const end = Date.now() + seconds * 1000;
let seq = 0;
while (Date.now() < end) {
  const h = new Database(dbPath);
  h.pragma('journal_mode = DELETE');
  h.pragma('busy_timeout = 5000');
  seq += 2;
  h.prepare('INSERT INTO messages_in (id, seq, content) VALUES (?, ?, ?)').run(`m${seq}`, seq, 'x');
  h.close();
  await new Promise((r) => setTimeout(r, Number(process.env.GAP_MS ?? 0)));
}
console.log(`[stress] host writes=${seq / 2} reader=${await reader}`);
rmSync(dir, { recursive: true, force: true });
