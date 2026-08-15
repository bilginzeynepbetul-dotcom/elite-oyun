// ============================================================
// errorTracker.js — Kalıcı hata izleme (ring buffer + webhook)
// ------------------------------------------------------------
// ERROR_WEBHOOK_URL=https://...   opsiyonel (Sentry-benzeri / Discord / özel)
// ERROR_LOG_FILE=./logs/errors.ndjson  opsiyonel dosya
// ERROR_BUFFER_SIZE=100
// ============================================================

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("./logger");

const BUFFER_SIZE = Math.min(
  500,
  Math.max(20, parseInt(process.env.ERROR_BUFFER_SIZE || "100", 10) || 100),
);
const WEBHOOK = (process.env.ERROR_WEBHOOK_URL || "").trim();
const LOG_FILE = (process.env.ERROR_LOG_FILE || "").trim();

/** @type {Array<object>} */
const buffer = [];
let totalCaptured = 0;

function eventId() {
  return (
    Date.now().toString(36) +
    "-" +
    crypto.randomBytes(4).toString("hex")
  );
}

function pushBuffer(ev) {
  buffer.push(ev);
  while (buffer.length > BUFFER_SIZE) buffer.shift();
  totalCaptured++;
}

function appendFile(ev) {
  if (!LOG_FILE) return;
  try {
    const dir = path.dirname(LOG_FILE);
    if (dir && dir !== "." && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(ev) + "\n", "utf8");
  } catch (e) {
    logger.warn("errorTracker file write failed", { err: e });
  }
}

async function postWebhook(ev) {
  if (!WEBHOOK) return;
  try {
    // Discord webhook uyumu: content + embeds sade
    const isDiscord = /discord(?:app)?\.com\/api\/webhooks/i.test(WEBHOOK);
    const body = isDiscord
      ? {
          content: null,
          embeds: [
            {
              title: "Elite Manager error",
              description: String(ev.message || "").slice(0, 1500),
              color: 15158332,
              fields: [
                { name: "id", value: ev.id, inline: true },
                { name: "path", value: String(ev.path || "-").slice(0, 200), inline: true },
                { name: "level", value: ev.level || "error", inline: true },
              ],
              timestamp: ev.ts,
            },
          ],
        }
      : {
          // Sentry-ish / generic envelope
          source: "elite-manager",
          ...ev,
        };
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    logger.warn("errorTracker webhook failed", { err: e });
  }
}

/**
 * Hatayı yakala, logla, buffer + dosya + webhook.
 * @param {Error|string} err
 * @param {object} [ctx]
 */
function captureError(err, ctx) {
  ctx = ctx || {};
  const message =
    typeof err === "string"
      ? err
      : (err && err.message) || String(err || "unknown");
  const ev = {
    id: eventId(),
    ts: new Date().toISOString(),
    level: ctx.level || "error",
    message,
    name: (err && err.name) || "Error",
    code: (err && err.code) || ctx.code || null,
    stack:
      err && err.stack
        ? String(err.stack).split("\n").slice(0, 15).join("\n")
        : null,
    path: ctx.path || null,
    method: ctx.method || null,
    status: ctx.status || null,
    userId: ctx.userId || null,
    requestId: ctx.requestId || null,
    tags: ctx.tags || null,
    meta: ctx.meta || null,
  };

  pushBuffer(ev);
  appendFile(ev);
  logger.error(message, {
    err,
    requestId: ev.requestId,
    path: ev.path,
    errorId: ev.id,
  });
  // fire-and-forget
  postWebhook(ev).catch(() => {});
  return ev;
}

function captureMessage(msg, ctx) {
  return captureError(msg, Object.assign({ level: "error" }, ctx || {}));
}

function getRecentErrors(limit) {
  limit = Math.min(BUFFER_SIZE, Math.max(1, limit || 50));
  return buffer.slice(-limit).reverse();
}

function getStats() {
  return {
    buffered: buffer.length,
    bufferSize: BUFFER_SIZE,
    totalCaptured,
    webhook: !!WEBHOOK,
    logFile: LOG_FILE || null,
  };
}

/** Express: request id + yavaş istek logu */
function requestContextMiddleware() {
  return function (req, res, next) {
    const rid =
      (req.headers["x-request-id"] && String(req.headers["x-request-id"])) ||
      eventId();
    req.requestId = rid;
    res.setHeader("X-Request-Id", rid);
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      const lvl =
        res.statusCode >= 500
          ? "error"
          : res.statusCode >= 400
            ? "warn"
            : ms > 3000
              ? "warn"
              : "debug";
      if (lvl === "debug" && (logger.debug ? true : false)) {
        // sadece yavaş veya hata
      }
      if (res.statusCode >= 500 || ms > 3000) {
        logger[lvl === "error" ? "error" : "warn"]("http", {
          requestId: rid,
          method: req.method,
          path: req.originalUrl || req.url,
          status: res.statusCode,
          ms,
          userId: req.user && (req.user.id || req.user.sub),
        });
      }
      if (res.statusCode >= 500) {
        captureError(new Error("HTTP " + res.statusCode), {
          path: req.originalUrl || req.url,
          method: req.method,
          status: res.statusCode,
          userId: req.user && req.user.id,
          requestId: rid,
          tags: ["http_5xx"],
        });
      }
    });
    next();
  };
}

/** Express 4-arg error handler */
function expressErrorHandler() {
  return function (err, req, res, next) {
    const ev = captureError(err, {
      path: req.originalUrl || req.url,
      method: req.method,
      status: 500,
      userId: req.user && req.user.id,
      requestId: req.requestId,
      tags: ["express"],
    });
    if (res.headersSent) return next(err);
    res.status(500).json({
      error: "Sunucu hatası",
      errorId: ev.id,
      requestId: req.requestId || null,
    });
  };
}

function installProcessHandlers() {
  process.on("uncaughtException", (err) => {
    captureError(err, { tags: ["uncaughtException"], level: "fatal" });
  });
  process.on("unhandledRejection", (reason) => {
    const err =
      reason instanceof Error ? reason : new Error(String(reason || "rejection"));
    captureError(err, { tags: ["unhandledRejection"] });
  });
}

/** uncaughtException uyumu */
function captureException(err, ctx) {
  return captureError(err, Object.assign({ level: "fatal" }, ctx || {}));
}

/** Alias — server.js / docs uyumu */
const getRecent = getRecentErrors;

/**
 * ERROR_ADMIN_TOKEN ile X-Error-Token header kontrolü
 * (admin kullanıcı yokken hata listesine erişim)
 */
function checkAdminToken(req) {
  const token = (process.env.ERROR_ADMIN_TOKEN || "").trim();
  if (!token) return false;
  const hdr = String(
    (req.headers &&
      (req.headers["x-error-token"] || req.headers["x-admin-token"])) ||
      (req.query && req.query.token) ||
      "",
  );
  // GÜVENLİK: sabit zamanlı karşılaştırma — normal === ile karakter
  // karakter erken çıkış yapıldığından token uzunluk/önek bilgisi
  // timing farkıyla sızabilir.
  const a = Buffer.from(hdr);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

module.exports = {
  captureError,
  captureException,
  captureMessage,
  getRecentErrors,
  getRecent,
  getStats,
  checkAdminToken,
  requestContextMiddleware,
  expressErrorHandler,
  installProcessHandlers,
};
