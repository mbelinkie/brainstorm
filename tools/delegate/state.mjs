// Private harness state outside the repository ($DELEGATE_HOME):
//   batch.json, tickets/<n>/state.json, tickets/<n>/..., ledger.csv, STOP
// Writes are atomic (temp file + rename) so a crash never leaves half a file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function delegateHome(env = process.env) {
  return env.DELEGATE_HOME || path.join(os.homedir(), ".local", "share", "brainstorm-delegate");
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function createState(home) {
  const batchFile = path.join(home, "batch.json");
  const ticketDir = (n) => path.join(home, "tickets", String(n));
  const ticketFile = (n) => path.join(ticketDir(n), "state.json");
  return {
    home,
    stopFile: path.join(home, "STOP"),
    ledgerFile: path.join(home, "ledger.csv"),
    ticketDir,
    readBatch: () => readJson(batchFile),
    writeBatch: (b) => writeJsonAtomic(batchFile, b),
    readTicket: (n) => readJson(ticketFile(n)),
    writeTicket: (n, t) => writeJsonAtomic(ticketFile(n), { ...t, updatedAt: new Date().toISOString() }),
    listTickets: () => {
      const dir = path.join(home, "tickets");
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b);
    },
    stopRequested: () => fs.existsSync(path.join(home, "STOP")),
  };
}

const LEDGER_COLUMNS = [
  "ticket", "title", "lane", "final_lane", "fit", "base_sha", "outcome", "attempts", "models", "deepseek_usd",
  "recon_quotes_verified", "codex_sessions", "codex_input", "codex_cached", "codex_output", "codex_credits",
  "sol_sessions", "decision", "repairs", "escalated", "pr", "merged_sha", "finished_at",
];

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function appendLedger(file, row) {
  const exists = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = LEDGER_COLUMNS.map((c) => csvCell(row[c])).join(",");
  fs.appendFileSync(file, `${exists ? "" : `${LEDGER_COLUMNS.join(",")}\n`}${line}\n`);
}

export { LEDGER_COLUMNS };
