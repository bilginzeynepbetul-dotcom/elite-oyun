// ============================================================
// botClubs.js — AI / bot kulüpler (seyrek lig doldurma)
// ------------------------------------------------------------
// Bot kulüpler: users satırı yok; clubs.user_id yerine
// ayrı bot kaydı. Şema: clubs.user_id NOT NULL olduğu için
// migration 003 ile nullable yapıyoruz + is_bot flag.
//
//   const botClubs = require("./botClubs");
//   await botClubs.ensureLeagueFilled({ country: "Türkiye", division: 1, targetSize: 10 });
// ============================================================

const { query, withTransaction } = require("./db");
const leagueRepo = require("./repos/leagueRepo");
const crypto = require("crypto");

const BOT_FIRST = [
  "Anadolu", "Ege", "Karadeniz", "Boğaz", "Akdeniz", "Trakya",
  "Marmara", "İç Anadolu", "Doğu", "Batı", "Yıldız", "Kartal",
  "Aslan", "Kurt", "Şimşek", "Fırtına", "Zafer", "Güneş",
];
const BOT_SECOND = [
  "SK", "FK", "United", "Spor", "FC", "City", "Town", "Athletic",
];

const POSITIONS_18 = [
  "GK", "DL", "DC", "DC", "DR", "DM", "MC", "MC", "OMC", "FL", "FR",
  "GK", "DC", "MC", "FC", "ML", "MR", "DM",
];

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function randomName(used) {
  for (let i = 0; i < 40; i++) {
    const n =
      BOT_FIRST[Math.floor(Math.random() * BOT_FIRST.length)] +
      " " +
      BOT_SECOND[Math.floor(Math.random() * BOT_SECOND.length)];
    if (!used.has(n.toLowerCase())) return n;
  }
  return "Bot FC " + Math.floor(Math.random() * 9000 + 1000);
}

function skillBase(strength) {
  // strength 1–10 → avg skill ~8–14
  return 7 + strength * 0.7 + Math.random() * 2;
}

function makePlayer(clubId, pos, idx, strength) {
  const base = skillBase(strength);
  const jitter = () => base + (Math.random() - 0.5) * 3;
  const first = [
    "Ali", "Mehmet", "Ahmet", "Mustafa", "Hasan", "Hüseyin", "İbrahim",
    "Yusuf", "Ömer", "Murat", "Serkan", "Tolga", "Cem", "Barış", "Onur",
    "Emre", "Can", "Burak", "Kerem", "Arda",
  ];
  const last = [
    "Yılmaz", "Kaya", "Demir", "Şahin", "Çelik", "Aydın", "Öztürk",
    "Arslan", "Doğan", "Kılıç", "Aslan", "Koç", "Polat", "Kurt", "Yıldız",
  ];
  return {
    id: uid(),
    club_id: clubId,
    name:
      first[Math.floor(Math.random() * first.length)] +
      " " +
      last[Math.floor(Math.random() * last.length)],
    number: idx + 1,
    pos,
    natural_pos: pos,
    age: 18 + Math.floor(Math.random() * 14),
    pace: jitter(),
    passing: jitter(),
    finishing: jitter(),
    tackle: jitter(),
    vision: jitter(),
    stamina: jitter(),
    strength: jitter(),
    technique: jitter(),
    agility: jitter(),
    positioning: jitter(),
    reflex: jitter(),
    handling: jitter(),
    condition: 85 + Math.floor(Math.random() * 15),
    form: 0,
    experience: 2 + Math.random() * 5,
    happiness: 70 + Math.floor(Math.random() * 25),
    base_quality: Math.max(1, Math.min(10, Math.round(strength * 0.8 + Math.random() * 3))),
    base_potential: Math.max(1, Math.min(10, Math.round(strength + Math.random() * 2))),
    is_starter: idx < 11,
    bench_order: idx < 11 ? null : idx - 11,
  };
}

/**
 * Tek bot kulüp oluştur (transaction client opsiyonel).
 */
async function createBotClub(opts = {}) {
  const country = opts.country || "Türkiye";
  const division = opts.division || 1;
  const strength = Math.max(1, Math.min(10, opts.strength || 4 + Math.floor(Math.random() * 4)));

  return withTransaction(async (client) => {
    const { rows: existingNames } = await client.query(
      `SELECT LOWER(name) AS n FROM clubs WHERE country = $1`,
      [country],
    );
    const used = new Set(existingNames.map((r) => r.n));
    const name = opts.name || randomName(used);

    const clubId = uid();
    // user_id NULL + is_bot TRUE (003 migration sonrası)
    await client.query(
      `INSERT INTO clubs (id, user_id, name, country, division, balance, is_bot)
       VALUES ($1, NULL, $2, $3, $4, $5, TRUE)`,
      [clubId, name, country, division, 2_000_000 + strength * 200_000],
    );

    await client.query(
      `INSERT INTO stadiums (club_id, name, capacity, ticket_price)
       VALUES ($1, $2, $3, $4)`,
      [
        clubId,
        name + " Stadium",
        12000 + strength * 2000,
        8 + Math.floor(strength / 2),
      ],
    );

    await client.query(
      `INSERT INTO youth_academy (club_id, scout_level, academy_level)
       VALUES ($1, $2, $2)`,
      [clubId, Math.min(5, 1 + Math.floor(strength / 3))],
    );

    await client.query(
      `INSERT INTO club_coaches (club_id, skill, level, salary, name)
       VALUES ($1, 'stamina', $2, $3, 'Bot Antrenör')`,
      [clubId, Math.min(5, 1 + Math.floor(strength / 2)), 5000 * strength],
    );

    for (let i = 0; i < POSITIONS_18.length; i++) {
      const p = makePlayer(clubId, POSITIONS_18[i], i, strength);
      await client.query(
        `INSERT INTO players (
           id, club_id, name, number, pos, natural_pos, age,
           pace, passing, finishing, tackle, vision, stamina,
           strength, technique, agility, positioning, reflex, handling,
           condition, form, experience, happiness,
           base_quality, base_potential, is_starter, bench_order
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,
           $8,$9,$10,$11,$12,$13,
           $14,$15,$16,$17,$18,$19,
           $20,$21,$22,$23,
           $24,$25,$26,$27
         )`,
        [
          p.id, clubId, p.name, p.number, p.pos, p.natural_pos, p.age,
          p.pace, p.passing, p.finishing, p.tackle, p.vision, p.stamina,
          p.strength, p.technique, p.agility, p.positioning, p.reflex, p.handling,
          p.condition, p.form, p.experience, p.happiness,
          p.base_quality, p.base_potential, p.is_starter, p.bench_order,
        ],
      );
    }

    return { id: clubId, name, country, division, strength, isBot: true };
  });
}

async function countClubs(country, division) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM clubs WHERE country = $1 AND division = $2`,
    [country, division],
  );
  return rows[0].c;
}

async function countHumanClubs(country, division) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM clubs
     WHERE country = $1 AND division = $2 AND COALESCE(is_bot, FALSE) = FALSE`,
    [country, division],
  );
  return rows[0].c;
}

/**
 * Ligi targetSize'a tamamla (bot ekle), standings'e yaz, isteğe bağlı fikstür üret.
 */
async function ensureLeagueFilled(opts = {}) {
  const country = opts.country || "Türkiye";
  const division = opts.division || 1;
  const targetSize = Math.max(2, opts.targetSize || 10);
  const generateFixtures = opts.generateFixtures !== false;
  const forceFixtures = !!opts.forceFixtures;

  const current = await countClubs(country, division);
  const need = Math.max(0, targetSize - current);
  const created = [];

  for (let i = 0; i < need; i++) {
    const strength = 3 + Math.floor(Math.random() * 5);
    const bot = await createBotClub({ country, division, strength });
    created.push(bot);
  }

  const season = await leagueRepo.getCurrentSeason(country, division);
  if (season) {
    const { rows: clubs } = await query(
      `SELECT id FROM clubs WHERE country = $1 AND division = $2`,
      [country, division],
    );
    for (const c of clubs) {
      await leagueRepo.ensureClubInStandings(season.id, c.id);
    }

    if (generateFixtures && (need > 0 || forceFixtures)) {
      const fx = await leagueRepo.generateFixturesForSeason(season.id, {
        force: forceFixtures || need > 0,
        intervalHours: opts.intervalHours != null ? opts.intervalHours : 3,
        intervalMinutes: opts.intervalMinutes,
        doubleRound: opts.doubleRound !== false,
        startAt: opts.startAt || new Date(Date.now() + 2 * 60 * 1000),
      });
      return {
        created: created.length,
        bots: created,
        totalClubs: current + created.length,
        fixtures: fx,
        seasonId: season.id,
      };
    }
  }

  return {
    created: created.length,
    bots: created,
    totalClubs: current + created.length,
    fixtures: null,
    seasonId: season ? season.id : null,
  };
}

/**
 * Bot takım objesini matchEngine için hazırla (getTeam ile aynı şekil).
 */
async function getBotTeam(clubId) {
  const clubsRepo = require("./repos/clubsRepo");
  return clubsRepo.getTeam(clubId);
}

module.exports = {
  createBotClub,
  ensureLeagueFilled,
  countClubs,
  countHumanClubs,
  getBotTeam,
};
