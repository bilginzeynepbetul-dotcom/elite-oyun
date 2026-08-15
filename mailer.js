// ============================================================
// mailer.js — e-posta gönderimi (opsiyonel altyapı)
// ------------------------------------------------------------
// Öncelik:
//   1) RESEND_API_KEY  → Resend HTTP API (bağımlılık yok)
//   2) SMTP_URL / SMTP_HOST + nodemailer (yüklüyse)
//   3) Aksi halde konsola link yazar (geliştirme)
// Ortam:
//   EMAIL_FROM=Elite Manager <noreply@yourdomain.com>
//   PUBLIC_URL=https://your-domain.com
//   RESEND_API_KEY=re_...
//   SMTP_HOST= SMTP_PORT=587 SMTP_USER= SMTP_PASS=
// ============================================================

const crypto = require("crypto");

function emailFrom() {
  return (
    process.env.EMAIL_FROM ||
    process.env.MAIL_FROM ||
    "Elite Manager <noreply@localhost>"
  );
}

function publicBase() {
  return String(process.env.PUBLIC_URL || "http://localhost:3000").replace(
    /\/$/,
    "",
  );
}

function makeVerifyToken() {
  return crypto.randomBytes(32).toString("hex");
}

function verifyLink(token) {
  return publicBase() + "/verify-email.html?token=" + encodeURIComponent(token);
}

async function sendViaResend({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, reason: "no_resend" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom(),
      to: [to],
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("Resend " + res.status + " " + body.slice(0, 200));
  }
  return { ok: true, provider: "resend" };
}

async function sendViaSmtp({ to, subject, html, text }) {
  const host = process.env.SMTP_HOST;
  if (!host && !process.env.SMTP_URL) return { ok: false, reason: "no_smtp" };
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch (_) {
    return { ok: false, reason: "nodemailer_missing" };
  }
  let transporter;
  if (process.env.SMTP_URL) {
    transporter = nodemailer.createTransport(process.env.SMTP_URL);
  } else {
    transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "") === "1",
      auth:
        process.env.SMTP_USER
          ? {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS || "",
            }
          : undefined,
    });
  }
  await transporter.sendMail({
    from: emailFrom(),
    to,
    subject,
    html,
    text,
  });
  return { ok: true, provider: "smtp" };
}

async function sendMail({ to, subject, html, text }) {
  if (!to) return { ok: false, reason: "no_to" };
  try {
    const r1 = await sendViaResend({ to, subject, html, text });
    if (r1.ok) return r1;
  } catch (e) {
    console.warn("[mailer] resend failed:", e.message || e);
  }
  try {
    const r2 = await sendViaSmtp({ to, subject, html, text });
    if (r2.ok) return r2;
  } catch (e) {
    console.warn("[mailer] smtp failed:", e.message || e);
  }
  // Geliştirme / yapılandırılmamış ortam
  console.log(
    "[mailer:dev] To:",
    to,
    "| Subject:",
    subject,
    "| Text:",
    text || "(html only)",
  );
  return { ok: true, provider: "console" };
}

async function sendEmailVerification(to, token) {
  const link = verifyLink(token);
  const subject = "Elite Manager — E-posta doğrulama";
  const text =
    "Elite Manager hesabını doğrulamak için bu bağlantıyı aç:\n\n" +
    link +
    "\n\nBağlantı 24 saat geçerlidir. Bu isteği sen yapmadıysan yok say.";
  const html =
    '<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#0f172a">' +
    "<p>Merhaba,</p>" +
    "<p>Elite Manager hesabındaki e-posta adresini doğrulamak için aşağıdaki düğmeye tıkla.</p>" +
    '<p><a href="' +
    link +
    '" style="display:inline-block;padding:10px 16px;background:#0ea5e9;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">E-postamı doğrula</a></p>' +
    "<p style=\"font-size:13px;color:#64748b\">veya bağlantı: " +
    link +
    "</p>" +
    "<p style=\"font-size:13px;color:#64748b\">24 saat geçerlidir. Bu isteği sen yapmadıysan yok say.</p>" +
    "</div>";
  return sendMail({ to, subject, html, text });
}

module.exports = {
  sendMail,
  sendEmailVerification,
  makeVerifyToken,
  verifyLink,
  publicBase,
};
