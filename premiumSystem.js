// ============================================================
// premiumSystem.js — Elite abonelik (sunucu kaynağı)
// ============================================================
const { query } = require("./db");

const PLANS = {
  weekly: {
    id: "weekly",
    title: "Haftalık",
    days: 7,
    amountCents: 4900,
    currency: "try",
    label: "49 ₺",
  },
  monthly: {
    id: "monthly",
    title: "Aylık",
    days: 30,
    amountCents: 14900,
    currency: "try",
    label: "149 ₺",
  },
  yearly: {
    id: "yearly",
    title: "Yıllık",
    days: 365,
    amountCents: 99900,
    currency: "try",
    label: "999 ₺",
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

/** Günlük ödül: herkes aynı (25.000 + seri×5.000), Elite çarpanı yok */
const DAILY_BASE = 25000;
const DAILY_STREAK_BONUS = 5000;
const DAILY_STREAK_MAX = 30;

function startOfLocalDay(d) {
  const x = d ? new Date(d) : new Date();
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

async function getDailyStatus(userId) {
  const { rows } = await query(
    `SELECT daily_reward_at, daily_reward_streak FROM users WHERE id = $1`,
    [userId],
  );
  const row = rows[0] || {};
  const last = row.daily_reward_at ? new Date(row.daily_reward_at) : null;
  const today = startOfLocalDay();
  const claimedToday = !!(last && last >= today);
  const streak = Number(row.daily_reward_streak) || 0;
  let nextStreak = 1;
  if (!claimedToday) {
    const yesterday = new Date(today.getTime() - 86400000);
    if (last && last >= yesterday && last < today) nextStreak = Math.min(DAILY_STREAK_MAX, streak + 1);
    else nextStreak = 1;
  } else {
    nextStreak = streak;
  }
  const amount = DAILY_BASE + nextStreak * DAILY_STREAK_BONUS;
  return {
    claimedToday,
    streak: claimedToday ? streak : nextStreak,
    amountIfClaim: amount,
    nextAt: new Date(today.getTime() + 86400000).toISOString(),
    lastAt: last ? last.toISOString() : null,
  };
}

/**
 * Atomik günlük ödül claim. Elite ile aynı tutar.
 * @returns {{ ok, amount?, streak?, balance?, code? }}
 */
async function claimDailyReward(userId, clubId) {
  if (!userId || !clubId) return { ok: false, error: "Kulüp yok", code: "NO_CLUB" };
  const clubsRepo = require("./repos/clubsRepo");
  const today = startOfLocalDay();

  const { rows } = await query(
    `SELECT daily_reward_at, daily_reward_streak FROM users WHERE id = $1`,
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

  let streak = Number(row.daily_reward_streak) || 0;
  const yesterday = new Date(today.getTime() - 86400000);
  if (last && last >= yesterday && last < today) streak += 1;
  else streak = 1;
  streak = Math.min(DAILY_STREAK_MAX, streak);

  const claim = await query(
    `UPDATE users
     SET daily_reward_at = NOW(), daily_reward_streak = $2
     WHERE id = $1
       AND (daily_reward_at IS NULL OR daily_reward_at < $3)
     RETURNING id`,
    [userId, streak, today.toISOString()],
  );
  if (!claim.rows.length) {
    return {
      ok: false,
      error: "Bugünkü ödül zaten alındı",
      code: "ALREADY_CLAIMED",
      nextAt: new Date(today.getTime() + 86400000).toISOString(),
    };
  }

  const amount = DAILY_BASE + streak * DAILY_STREAK_BONUS;
  const ok = await clubsRepo.adjustBalance(clubId, amount, "Günlük giriş ödülü");
  if (!ok) {
    return { ok: false, error: "Bütçe güncellenemedi", code: "BALANCE" };
  }
  const eco = await clubsRepo.getEconomy(clubId);
  const elite = await getStatus(userId);
  return {
    ok: true,
    amount,
    streak,
    elite: !!(elite && elite.active),
    balance: eco && eco.balance,
  };
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
  requireElite,
  eliteMiddleware,
  getDailyStatus,
  claimDailyReward,
  DAILY_BASE,
  DAILY_STREAK_BONUS,
};
