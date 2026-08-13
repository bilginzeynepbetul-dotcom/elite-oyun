// ============================================================
// premiumSystem.js — Elite abonelik (sunucu kaynağı)
// ============================================================
const { query } = require("./db");

const PLANS = {
  weekly: {
    id: "weekly",
    title: "Haftalık",
    days: 7,
    amountCents: 1900,
    currency: "try",
    label: "19 ₺",
  },
  monthly: {
    id: "monthly",
    title: "Aylık",
    days: 30,
    amountCents: 3900,
    currency: "try",
    label: "39 ₺",
  },
  yearly: {
    id: "yearly",
    title: "Yıllık",
    days: 365,
    amountCents: 39900,
    currency: "try",
    label: "399 ₺",
  },
  trial: {
    id: "trial",
    title: "Deneme",
    days: 14,
    amountCents: 0,
    currency: "try",
    label: "Ücretsiz",
  },
};

const TRIAL_DAYS = 14;

function stripeEnabled() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith("sk_"));
}

function publicStatus(row) {
  if (!row) return { active: false, plan: null, until: null, trial: false };
  const until = row.elite_until ? new Date(row.elite_until).getTime() : null;
  const active = !!(until && until > Date.now());
  const plan = row.elite_plan || null;
  return {
    active,
    plan: active ? plan : null,
    until: active ? until : null,
    trial: active && plan === "trial",
    provider: row.elite_provider || null,
  };
}

async function getUserEliteRow(userId) {
  const { rows } = await query(
    `SELECT elite_plan, elite_until, elite_trial_started_at, elite_provider, elite_provider_ref
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] || null;
}

async function getStatus(userId) {
  const row = await getUserEliteRow(userId);
  return publicStatus(row);
}

/** İlk kayıt / girişte 14 gün deneme (yalnızca bir kez) */
async function ensureTrial(userId) {
  const row = await getUserEliteRow(userId);
  if (!row) return publicStatus(null);

  // Zaten ücretli aktif plan
  if (row.elite_until && new Date(row.elite_until).getTime() > Date.now()) {
    if (row.elite_plan && row.elite_plan !== "trial") {
      return publicStatus(row);
    }
  }

  // Deneme daha önce başladıysa dokunma
  if (row.elite_trial_started_at) {
    return publicStatus(row);
  }

  const until = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `UPDATE users SET
       elite_plan = 'trial',
       elite_until = $2,
       elite_trial_started_at = NOW(),
       elite_provider = 'trial'
     WHERE id = $1`,
    [userId, until.toISOString()],
  );
  return getStatus(userId);
}

async function activatePlan(userId, planId, opts) {
  opts = opts || {};
  const plan = PLANS[planId];
  if (!plan || planId === "trial") {
    return { ok: false, error: "Geçersiz plan" };
  }
  const row = await getUserEliteRow(userId);
  let base = Date.now();
  if (row && row.elite_until) {
    const u = new Date(row.elite_until).getTime();
    if (u > base && row.elite_plan && row.elite_plan !== "trial") base = u;
  }
  const until = new Date(base + plan.days * 24 * 60 * 60 * 1000);
  await query(
    `UPDATE users SET
       elite_plan = $2,
       elite_until = $3,
       elite_provider = $4,
       elite_provider_ref = $5
     WHERE id = $1`,
    [
      userId,
      planId,
      until.toISOString(),
      opts.provider || "mock",
      opts.providerRef || null,
    ],
  );
  if (opts.paymentId) {
    await query(
      `UPDATE elite_payments SET status = 'completed', completed_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [opts.paymentId, userId],
    );
  }
  return { ok: true, status: await getStatus(userId) };
}

async function createPaymentRecord(userId, planId, provider, providerRef) {
  const plan = PLANS[planId];
  if (!plan || planId === "trial") return { ok: false, error: "Geçersiz plan" };
  const { rows } = await query(
    `INSERT INTO elite_payments (user_id, plan, amount_cents, currency, provider, provider_ref, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING id`,
    [
      userId,
      planId,
      plan.amountCents,
      plan.currency,
      provider || "mock",
      providerRef || null,
    ],
  );
  return { ok: true, paymentId: rows[0].id, plan };
}

/** Stripe Checkout Session (opsiyonel) */
async function createStripeCheckout(userId, username, planId, successUrl, cancelUrl) {
  if (!stripeEnabled()) {
    return { ok: false, error: "Stripe yapılandırılmamış", mock: true };
  }
  const plan = PLANS[planId];
  if (!plan || planId === "trial") return { ok: false, error: "Geçersiz plan" };

  const Stripe = require("stripe");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const pay = await createPaymentRecord(userId, planId, "stripe", null);
  if (!pay.ok) return pay;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: undefined,
    client_reference_id: String(userId),
    metadata: {
      userId: String(userId),
      username: String(username || ""),
      plan: planId,
      paymentId: String(pay.paymentId),
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: plan.currency,
          unit_amount: plan.amountCents,
          product_data: {
            name: "Elite Manager — " + plan.title,
            description: plan.days + " gün Elite üyelik",
          },
        },
      },
    ],
    success_url:
      (successUrl || process.env.PUBLIC_URL || "http://localhost:3000") +
      "?elite=success&plan=" +
      planId,
    cancel_url:
      (cancelUrl || process.env.PUBLIC_URL || "http://localhost:3000") +
      "?elite=cancel",
  });

  await query(
    `UPDATE elite_payments SET provider_ref = $2 WHERE id = $1`,
    [pay.paymentId, session.id],
  );

  return {
    ok: true,
    checkoutUrl: session.url,
    sessionId: session.id,
    paymentId: pay.paymentId,
    mock: false,
  };
}

/** Stripe webhook: checkout.session.completed */
async function handleStripeWebhookEvent(event) {
  if (!event || event.type !== "checkout.session.completed") {
    return { ok: true, ignored: true };
  }
  const session = event.data && event.data.object;
  if (!session) return { ok: false, error: "session yok" };
  const meta = session.metadata || {};
  const userId = parseInt(meta.userId || session.client_reference_id, 10);
  const planId = meta.plan;
  const paymentId = meta.paymentId ? parseInt(meta.paymentId, 10) : null;
  if (!userId || !planId || !PLANS[planId]) {
    return { ok: false, error: "metadata eksik" };
  }
  return activatePlan(userId, planId, {
    provider: "stripe",
    providerRef: session.id,
    paymentId: paymentId || undefined,
  });
}

/** Mock / test ödeme onayı — SADECE açıkça ELITE_ALLOW_MOCK=1 iken.
 *  GÜVENLİK: Stripe yok diye otomatik açmak production'da ücretsiz Elite
 *  sömürüsüne yol açıyordu; artık varsayılan kapalı. */
async function confirmMockPayment(userId, planId) {
  const allowMock =
    process.env.ELITE_ALLOW_MOCK === "1" ||
    process.env.ELITE_ALLOW_MOCK === "true";
  if (!allowMock) {
    return { ok: false, error: "Mock ödeme kapalı. Stripe kullanın veya ELITE_ALLOW_MOCK=1 ayarlayın." };
  }
  const pay = await createPaymentRecord(userId, planId, "mock", "mock_" + Date.now());
  if (!pay.ok) return pay;
  return activatePlan(userId, planId, {
    provider: "mock",
    providerRef: pay.providerRef || "mock",
    paymentId: pay.paymentId,
  });
}

function listPlansPublic() {
  return ["weekly", "monthly", "yearly"].map((id) => {
    const p = PLANS[id];
    return {
      id: p.id,
      title: p.title,
      days: p.days,
      price: p.label,
      amountCents: p.amountCents,
      currency: p.currency,
    };
  });
}


/** Elite aktif değilse { ok:false } */
async function requireElite(userId) {
  const status = await getStatus(userId);
  if (!status || !status.active) {
    return {
      ok: false,
      error: "Bu özellik Elite üyelik gerektirir",
      code: "ELITE_REQUIRED",
      status: status || { active: false },
    };
  }
  return { ok: true, status };
}

/** Express middleware: req.user.id Elite olmalı */
function eliteMiddleware(req, res, next) {
  const userId = req.user && req.user.id;
  if (!userId) return res.status(401).json({ error: "Giriş gerekli", code: "AUTH" });
  requireElite(userId)
    .then((r) => {
      if (!r.ok) return res.status(403).json(r);
      req.elite = r.status;
      next();
    })
    .catch((e) => {
      console.error("[eliteMiddleware]", e);
      res.status(500).json({ error: "Elite kontrolü başarısız" });
    });
}

/** Günlük ödül: herkes aynı sabit tutar, seri yok, Elite çarpanı yok */
const DAILY_AMOUNT = 50000;

function startOfLocalDay(d) {
  const x = d ? new Date(d) : new Date();
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

async function getDailyStatus(userId) {
  const { rows } = await query(
    `SELECT daily_reward_at FROM users WHERE id = $1`,
    [userId],
  );
  const row = rows[0] || {};
  const last = row.daily_reward_at ? new Date(row.daily_reward_at) : null;
  const today = startOfLocalDay();
  const claimedToday = !!(last && last >= today);
  return {
    claimedToday,
    amountIfClaim: DAILY_AMOUNT,
    nextAt: new Date(today.getTime() + 86400000).toISOString(),
    lastAt: last ? last.toISOString() : null,
  };
}

/**
 * Atomik günlük ödül claim. Her gün aynı tutar, seri yok.
 * @returns {{ ok, amount?, balance?, code? }}
 */
async function claimDailyReward(userId, clubId) {
  if (!userId || !clubId) return { ok: false, error: "Kulüp yok", code: "NO_CLUB" };
  const clubsRepo = require("./repos/clubsRepo");
  const today = startOfLocalDay();

  const { rows } = await query(
    `SELECT daily_reward_at FROM users WHERE id = $1`,
    [userId],
  );
  const row = rows[0] || {};
  const last = row.daily_reward_at ? new Date(row.daily_reward_at) : null;
  if (last && last >= today) {
    return {
      ok: false,
      error: "Bugünkü ödül zaten alındı",
      code: "ALREADY_CLAIMED",
      nextAt: new Date(today.getTime() + 86400000).toISOString(),
    };
  }

  const claim = await query(
    `UPDATE users
     SET daily_reward_at = NOW(), daily_reward_streak = 0
     WHERE id = $1
       AND (daily_reward_at IS NULL OR daily_reward_at < $2)
     RETURNING id`,
    [userId, today.toISOString()],
  );
  if (!claim.rows.length) {
    return {
      ok: false,
      error: "Bugünkü ödül zaten alındı",
      code: "ALREADY_CLAIMED",
      nextAt: new Date(today.getTime() + 86400000).toISOString(),
    };
  }

  const amount = DAILY_AMOUNT;
  const ok = await clubsRepo.adjustBalance(clubId, amount, "Günlük giriş ödülü");
  if (!ok) {
    return { ok: false, error: "Bütçe güncellenemedi", code: "BALANCE" };
  }
  const eco = await clubsRepo.getEconomy(clubId);
  const elite = await getStatus(userId);
  return {
    ok: true,
    amount,
    elite: !!(elite && elite.active),
    balance: eco && eco.balance,
  };
}


// ============================================================
// BAĞIŞ / DESTEK OL
// ============================================================

function getDonationMethodsPublic() {
  return {
    iban: process.env.DONATION_IBAN || "",
    ibanName: process.env.DONATION_IBAN_NAME || "",
    papara: process.env.DONATION_PAPARA || "",
    paparaName: process.env.DONATION_PAPARA_NAME || "",
    other: process.env.DONATION_OTHER || "",
    note:
      process.env.DONATION_NOTE ||
      "Açıklamaya kullanıcı adını yaz. Dekont sonrası bağış formunu doldur; yönetici onaylayınca Elite aktif olur.",
    currency: "TRY",
  };
}

async function createDonation(userId, payload) {
  payload = payload || {};
  const planId = String(payload.plan || "").trim();
  const plan = PLANS[planId];
  if (!plan || planId === "trial") {
    return { ok: false, error: "Geçersiz plan (weekly / monthly / yearly)" };
  }
  const method = String(payload.method || "iban").toLowerCase().slice(0, 32);
  const referenceCode = String(payload.referenceCode || payload.reference || "")
    .trim()
    .slice(0, 120);
  const note = String(payload.note || "").trim().slice(0, 500);
  const payerName = String(payload.payerName || "").trim().slice(0, 120);
  if (!referenceCode && !payerName) {
    return {
      ok: false,
      error: "Referans / dekont no veya gönderen adı gerekli",
    };
  }
  // Aynı kullanıcıda çok fazla bekleyen bağış olmasın
  const { rows: pending } = await query(
    `SELECT COUNT(*)::int AS c FROM donations
     WHERE user_id = $1 AND status = 'pending'`,
    [userId],
  );
  if (pending[0] && pending[0].c >= 5) {
    return {
      ok: false,
      error: "Zaten 5 bekleyen bağışın var. Onay bekleyin veya iptal edin.",
    };
  }
  const { rows } = await query(
    `INSERT INTO donations
       (user_id, plan, amount_cents, currency, method, reference_code, note, payer_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     RETURNING id, plan, amount_cents, currency, method, reference_code, note, payer_name, status, created_at`,
    [
      userId,
      planId,
      plan.amountCents,
      plan.currency,
      method,
      referenceCode || null,
      note || null,
      payerName || null,
    ],
  );
  // elite_payments kaydı da tut (rapor)
  try {
    await createPaymentRecord(
      userId,
      planId,
      "donation",
      "don_" + rows[0].id,
    );
  } catch (e) {}
  return {
    ok: true,
    donation: rows[0],
    message:
      "Bağış bildirimin alındı. Yönetici onaylayınca Elite aktifleşir.",
  };
}

async function listMyDonations(userId, limit) {
  const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const { rows } = await query(
    `SELECT id, plan, amount_cents, currency, method, reference_code, note,
            payer_name, status, admin_note, created_at, reviewed_at
     FROM donations WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, lim],
  );
  return rows;
}

async function cancelMyDonation(userId, donationId) {
  const { rows } = await query(
    `UPDATE donations SET status = 'cancelled', reviewed_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING id`,
    [donationId, userId],
  );
  if (!rows[0]) return { ok: false, error: "İptal edilecek bekleyen bağış yok" };
  return { ok: true, id: rows[0].id };
}

async function listPendingDonations(limit) {
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const { rows } = await query(
    `SELECT d.id, d.user_id, d.plan, d.amount_cents, d.currency, d.method,
            d.reference_code, d.note, d.payer_name, d.status, d.created_at,
            u.username
     FROM donations d
     JOIN users u ON u.id = d.user_id
     WHERE d.status = 'pending'
     ORDER BY d.created_at ASC
     LIMIT $1`,
    [lim],
  );
  return rows;
}

async function reviewDonation(donationId, adminUserId, accept, adminNote) {
  const { rows } = await query(
    `SELECT * FROM donations WHERE id = $1`,
    [donationId],
  );
  const don = rows[0];
  if (!don) return { ok: false, error: "Bağış bulunamadı" };
  if (don.status !== "pending") {
    return { ok: false, error: "Bu bağış zaten işlendi: " + don.status };
  }
  if (!accept) {
    await query(
      `UPDATE donations SET status = 'rejected', admin_note = $2,
         reviewed_by = $3, reviewed_at = NOW()
       WHERE id = $1`,
      [donationId, String(adminNote || "").slice(0, 500) || null, adminUserId || null],
    );
    return { ok: true, status: "rejected" };
  }
  const act = await activatePlan(don.user_id, don.plan, {
    provider: "donation",
    providerRef: "don_" + don.id,
  });
  if (!act.ok) return act;
  await query(
    `UPDATE donations SET status = 'approved', admin_note = $2,
       reviewed_by = $3, reviewed_at = NOW()
     WHERE id = $1`,
    [donationId, String(adminNote || "").slice(0, 500) || null, adminUserId || null],
  );
  return { ok: true, status: "approved", elite: act.status };
}


module.exports = {
  PLANS,
  stripeEnabled,
  getStatus,
  ensureTrial,
  activatePlan,
  createStripeCheckout,
  handleStripeWebhookEvent,
  confirmMockPayment,
  listPlansPublic,
  getDonationMethodsPublic,
  createDonation,
  listMyDonations,
  cancelMyDonation,
  listPendingDonations,
  reviewDonation,
  requireElite,
  eliteMiddleware,
  getDailyStatus,
  claimDailyReward,
  DAILY_AMOUNT,
};
