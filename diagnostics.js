const DIAGNOSTICS_KEY = "quiz-control:diagnostics:v1";
const SENSITIVE = /secret|token|authorization|api.?key|password/i;
let sentry = null;

function safe(value) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 4).join("\n") };
  if (!value || typeof value !== "object") return String(value || "Unknown error");
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE.test(key)).map(([key, entry]) => [key, typeof entry === "string" ? entry.slice(0, 300) : entry]));
}

export function diagnostics() {
  try { return JSON.parse(localStorage.getItem(DIAGNOSTICS_KEY) || "[]"); } catch { return []; }
}

export function recordDiagnostic(scope, error, context = {}) {
  const entry = { at: new Date().toISOString(), scope, error: safe(error), context: safe(context) };
  try { localStorage.setItem(DIAGNOSTICS_KEY, JSON.stringify([...diagnostics(), entry].slice(-30))); } catch { /* Diagnostics must never interrupt a quiz. */ }
  sentry?.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { scope }, extra: safe(context) });
  console.warn(`[Quiz Control: ${scope}]`, error);
}

export function startDiagnostics(scope) {
  const dsn = window.QUIZ_PLATFORM_CONFIG?.sentryDsn;
  if (dsn) import("https://esm.sh/@sentry/browser@10.18.0").then((Sentry) => {
    Sentry.init({ dsn, environment: location.hostname === "localhost" ? "development" : "production", sendDefaultPii: false, beforeSend(event) { delete event.user; return event; } });
    sentry = Sentry;
  }).catch((error) => console.warn("External diagnostics unavailable.", error));
  window.addEventListener("error", (event) => recordDiagnostic(scope, event.error || event.message, { source: event.filename, line: event.lineno }));
  window.addEventListener("unhandledrejection", (event) => recordDiagnostic(scope, event.reason, { source: "unhandled promise rejection" }));
}

export function downloadDiagnostics() {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries: diagnostics() }, null, 2) + "\n"], { type: "application/json" });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "quiz-control-diagnostics.json" });
  link.click();
  URL.revokeObjectURL(link.href);
}
