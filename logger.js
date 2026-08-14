// ============================================================
// logger.js — Yapılandırılmış JSON log
// ------------------------------------------------------------
// LOG_LEVEL=debug|info|warn|error  (varsayılan: info)
// LOG_FORMAT=json|text             (varsayılan: json prod'da, text dev)
// ============================================================

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

const envLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();
const minLevel = LEVELS[envLevel] != null ? LEVELS[envLevel] : LEVELS.info;

const format =
  process.env.LOG_FORMAT ||
  (process.env.NODE_ENV === "production" ? "json" : "text");

function ts() {
  return new Date().toISOString();
}

function serializeErr(err) {
  if (!err) return undefined;
  if (typeof err === "string") return { message: err };
  return {
    message: err.message || String(err),
    name: err.name || "Error",
    code: err.code,
    stack:
      process.env.LOG_STACK === "0"
        ? undefined
        : err.stack
          ? String(err.stack).split("\n").slice(0, 12).join("\n")
          : undefined,
  };
}

function write(level, msg, meta) {
  if ((LEVELS[level] || 99) < minLevel) return;
  const entry = {
    ts: ts(),
    level,
    msg: String(msg || ""),
  };
  if (meta && typeof meta === "object") {
    Object.keys(meta).forEach((k) => {
      if (k === "err" || k === "error") {
        entry.err = serializeErr(meta[k]);
      } else if (meta[k] !== undefined) {
        entry[k] = meta[k];
      }
    });
  }
  const line =
    format === "text"
      ? `[${entry.ts}] ${level.toUpperCase()} ${entry.msg}` +
        (entry.err ? " | " + entry.err.message : "") +
        (meta && meta.requestId ? " rid=" + meta.requestId : "")
      : JSON.stringify(entry);

  if (level === "error" || level === "fatal") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
  return entry;
}

const logger = {
  debug: (msg, meta) => write("debug", msg, meta),
  info: (msg, meta) => write("info", msg, meta),
  warn: (msg, meta) => write("warn", msg, meta),
  error: (msg, meta) => write("error", msg, meta),
  fatal: (msg, meta) => write("fatal", msg, meta),
  child(bindings) {
    const base = bindings || {};
    return {
      debug: (msg, meta) => write("debug", msg, Object.assign({}, base, meta)),
      info: (msg, meta) => write("info", msg, Object.assign({}, base, meta)),
      warn: (msg, meta) => write("warn", msg, Object.assign({}, base, meta)),
      error: (msg, meta) => write("error", msg, Object.assign({}, base, meta)),
      fatal: (msg, meta) => write("fatal", msg, Object.assign({}, base, meta)),
    };
  },
};

module.exports = logger;
