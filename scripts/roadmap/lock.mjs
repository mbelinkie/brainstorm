// Host-local lock for cooperating roadmap processes (playbook section 5).
//
// This covers ONLY processes on this host that go through the gate. It does not
// coordinate other hosts, other people, or tools that bypass the gate; for those
// the playbook calls for one authorized dispatcher or a real shared mechanism.
//
// Rules, taken straight from the playbook:
// - Contention is refused up front, before any network call.
// - A live owner never loses the lock merely because it is old.
// - Only a dead owner's lock is recovered, and only conservatively.
//
// Known limits, stated rather than hidden: process IDs can be reused, so a dead
// owner's recycled PID reads as alive and the lock is refused (safe direction).
// And two processes recovering the same dead lock at the same instant have a
// narrow race between the check and the delete; acceptable for one person on one
// machine, and one more reason the multi-host case needs a dispatcher.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultLockPath() {
  // Outside the repo so every worktree on this host shares one lock.
  return process.env.ROADMAP_LOCK_PATH || path.join(os.tmpdir(), "brainstorm-roadmap-gate.lock");
}

export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

function readOwner(lockPath) {
  try {
    return { raw: fs.readFileSync(lockPath, "utf8"), missing: false };
  } catch (error) {
    if (error.code === "ENOENT") return { raw: null, missing: true };
    return { raw: null, missing: false, error };
  }
}

function parseOwner(raw) {
  try {
    const owner = JSON.parse(raw);
    return owner && Number.isInteger(owner.pid) && typeof owner.token === "string" ? owner : null;
  } catch {
    return null;
  }
}

function contended(message, owner) {
  return {
    ok: false,
    code: "LOCK_CONTENDED",
    message,
    owner: owner ? { pid: owner.pid, host: owner.host, acquiredAt: owner.acquiredAt, label: owner.label } : null,
  };
}

export function acquireLock({
  lockPath = defaultLockPath(),
  pid = process.pid,
  host = os.hostname(),
  now = Date.now,
  isAlive = defaultIsAlive,
  label = "",
} = {}) {
  const token = crypto.randomUUID();
  const record = JSON.stringify({ pid, host, token, label, acquiredAt: new Date(now()).toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, record);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, token, release: () => releaseLock(lockPath, token) };
    } catch (error) {
      if (error.code !== "EEXIST") {
        return { ok: false, code: "LOCK_ERROR", message: `could not create lock file: ${error.message}` };
      }
    }

    const read = readOwner(lockPath);
    if (read.missing) continue; // released between our create and our read; try again
    if (read.error) return contended(`lock file is unreadable: ${read.error.message}`, null);

    const owner = parseOwner(read.raw);
    // An unreadable record may be a writer mid-write. Never delete what we cannot read.
    if (!owner) return contended("lock file has an unreadable owner record; inspect it before removing it", null);
    if (owner.host !== host) {
      return contended(`lock is held from another host (${owner.host}); its liveness cannot be checked`, owner);
    }
    if (isAlive(owner.pid)) {
      return contended(`lock is held by a live process (pid ${owner.pid}); age alone never evicts a live owner`, owner);
    }

    // Dead owner on this host. Delete only if the file is still exactly what we read.
    const again = readOwner(lockPath);
    if (again.raw !== read.raw) continue;
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") return contended(`could not remove the stale lock: ${error.message}`, owner);
    }
  }
  return contended("lock could not be acquired after recovering a stale owner", null);
}

export function releaseLock(lockPath, token) {
  const read = readOwner(lockPath);
  if (!read.raw) return false;
  const owner = parseOwner(read.raw);
  if (!owner || owner.token !== token) return false; // not ours; leave it alone
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
