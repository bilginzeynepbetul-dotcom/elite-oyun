// ============================================================
// botClubs.js — AI / bot kulüpler (seyrek lig doldurma)
// ------------------------------------------------------------
// Bot kulüpler: users satırı yok; clubs.user_id yerine
// ayrı bot kaydı. Şema: clubs.user_id NOT NULL olduğu için
// migration 003 ile nullable yapıyoruz + is_bot flag.
//
//   const botClubs = require("./botClubs");
//   await botClubs.ensureLeagueFilled({ country: "Türkiye", division: 1, targetSize: 8 });
// ============================================================

const { query, withTransaction } = require("./db");
const leagueRepo = require("./repos/leagueRepo");
const crypto = require("crypto");

const BOT_FIRST = [
  "Anadolu", "Ege", "Karadeniz", "Boğaz", "Akdeniz", "Trakya",
  "Marmara", "İç Anadolu", "Doğu", "Batı", "Yıldız", "Kartal",
  "Aslan", "Kurt", "Şimşek", "Fırtına", "Zafer", "Güneş",
  "Toros", "Kaya", "Çelik", "Demir", "Gençlik", "Birlik",
  "Yeşil", "Kızıl", "Boz", "Doğa", "Rüzgar", "Deniz",
];
const BOT_SECOND = [
  "SK", "FK", "United", "Spor", "FC", "City", "Town", "Athletic",
  "Gücü", "Gençlikspor", "Belediyespor", "Idmanyurdu", "Yıldızspor",
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
  // strength 1–10 → tipik ortalama ~6.5–12 (herkese yüksek skill yok)
  return 5.2 + strength * 0.55 + Math.random() * 1.4;
}

/** Mevkiye göre skill ağırlıkları (ana roller yüksek, diğerleri mantıklı düşük) */
function posSkillMods(pos) {
  const p = String(pos || "").toUpperCase();
  // sıra: pace,passing,finishing,tackle,vision,stamina,strength,technique,agility,positioning,reflex,handling
  const table = {
    GK:  { pace: -2.2, passing: -0.8, finishing: -4.0, tackle: -2.0, vision: -0.6, stamina: -0.5, strength: 0.4, technique: -0.5, agility: 1.2, positioning: 2.2, reflex: 4.2, handling: 4.0 },
    DC:  { pace: -0.8, passing: -0.6, finishing: -2.8, tackle: 3.2, vision: -0.8, stamina: 1.0, strength: 2.4, technique: -0.6, agility: -0.6, positioning: 3.0, reflex: -3.0, handling: -4.0 },
    DL:  { pace: 1.4, passing: 0.2, finishing: -2.2, tackle: 2.2, vision: -0.4, stamina: 1.2, strength: 0.6, technique: 0.2, agility: 1.0, positioning: 1.8, reflex: -3.0, handling: -4.0 },
    DR:  { pace: 1.4, passing: 0.2, finishing: -2.2, tackle: 2.2, vision: -0.4, stamina: 1.2, strength: 0.6, technique: 0.2, agility: 1.0, positioning: 1.8, reflex: -3.0, handling: -4.0 },
    DM:  { pace: -0.4, passing: 1.4, finishing: -2.0, tackle: 2.4, vision: 0.8, stamina: 1.6, strength: 1.2, technique: 0.4, agility: -0.2, positioning: 1.6, reflex: -3.0, handling: -4.0 },
    MC:  { pace: 0.2, passing: 2.4, finishing: -0.8, tackle: 0.6, vision: 2.2, stamina: 1.4, strength: 0.2, technique: 1.6, agility: 0.4, positioning: 0.8, reflex: -3.0, handling: -4.0 },
    ML:  { pace: 1.8, passing: 1.2, finishing: 0.2, tackle: -0.6, vision: 0.8, stamina: 1.2, strength: -0.4, technique: 1.4, agility: 1.6, positioning: 0.2, reflex: -3.0, handling: -4.0 },
    MR:  { pace: 1.8, passing: 1.2, finishing: 0.2, tackle: -0.6, vision: 0.8, stamina: 1.2, strength: -0.4, technique: 1.4, agility: 1.6, positioning: 0.2, reflex: -3.0, handling: -4.0 },
    OMC: { pace: 0.4, passing: 2.6, finishing: 1.2, tackle: -1.2, vision: 2.8, stamina: 0.6, strength: -0.4, technique: 2.2, agility: 0.8, positioning: 0.6, reflex: -3.0, handling: -4.0 },
    FL:  { pace: 2.4, passing: 0.6, finishing: 1.6, tackle: -1.6, vision: 0.4, stamina: 0.8, strength: -0.6, technique: 1.6, agility: 2.2, positioning: 0.2, reflex: -3.0, handling: -4.0 },
    FR:  { pace: 2.4, passing: 0.6, finishing: 1.6, tackle: -1.6, vision: 0.4, stamina: 0.8, strength: -0.6, technique: 1.6, agility: 2.2, positioning: 0.2, reflex: -3.0, handling: -4.0 },
    FC:  { pace: 0.8, passing: -0.4, finishing: 3.4, tackle: -2.0, vision: 0.2, stamina: 0.8, strength: 1.8, technique: 1.4, agility: 0.6, positioning: 1.6, reflex: -3.0, handling: -4.0 },
  };
  return table[p] || table.MC;
}

function clampSkill(v) {
  // 4–17 arası; süperstar yağmuru yok
  return Math.max(4, Math.min(17, Math.round(v * 10) / 10));
}

function makePlayer(clubId, pos, idx, strength) {
  const base = skillBase(strength);
  const mods = posSkillMods(pos);
  // Birincil roller biraz daha tutarlı, ikinciller daha dağınık
  function sk(mod, primary) {
    const spread = primary ? 1.6 : 2.4;
    return clampSkill(base + mod + (Math.random() - 0.5) * spread);
  }
  const first = [
    "Ali", "Mehmet", "Ahmet", "Mustafa", "Hasan", "Hüseyin", "İbrahim",
    "Yusuf", "Ömer", "Murat", "Serkan", "Tolga", "Cem", "Barış", "Onur",
    "Emre", "Can", "Burak", "Kerem", "Arda", "Berkay", "Volkan", "Kaan",
    "Mert", "Furkan", "Deniz", "Alp", "Yiğit", "Efe", "Umut", "Gökhan",
    "Selim", "Taner", "Baran", "Enes", "Uğur", "Erhan", "Sinan",
    "Metehan", "Kağan", "Bora", "Eren", "Kenan", "Bahadır", "Tayfun",
    "Oğuzhan", "Görkem", "İlker", "Rıdvan", "Semih", "Doruk", "Berkan",
    "Cenk", "Ozan", "Hakan", "Çağatay", "Tuna", "Batuhan", "Koray",
    "Levent", "Alper", "Faruk", "Salih", "Vedat", "Zafer", "Metin",
    "Atakan", "Emir", "Ferhat", "Harun", "İdris", "Kuzey", "Okan",
    "Samet", "Utku", "Yavuz", "Zeki", "Berke", "Ege", "Fırat", "Sarp",
    "Taha", "Poyraz", "Rüzgar", "Çınar", "Alparslan", "Abdullah", "Adem",
    "Anıl", "Berk", "Bilal", "Cengiz", "Doğan", "Erdem", "Erkan", "Fatih",
    "Hamza", "İlyas", "Kadir", "Kemal", "Mahmut", "Mesut", "Oğuz", "Özgür",
    "Lucas", "Gabriel", "James", "Harry", "Marco", "Luca", "Carlos", "Diego",
    "Hugo", "Paul", "Kai", "Leon", "Jonas", "Felix", "Santiago", "Mateo",
  ];
  const last = [
    "Yılmaz", "Kaya", "Demir", "Şahin", "Çelik", "Aydın", "Öztürk",
    "Arslan", "Doğan", "Kılıç", "Aslan", "Koç", "Polat", "Kurt", "Yıldız",
    "Özdemir", "Çetin", "Aksoy", "Bulut", "Sarı", "Yavuz", "Erdoğan",
    "Güneş", "Korkmaz", "Kaplan", "Türk", "Avcı", "Yıldırım", "Aktaş",
    "Öz", "Karaca", "Tunç", "Uçar", "Bozkurt", "Aygün", "Çakır", "Duman",
    "Ergin", "Tekin", "Yalçın", "Şimşek", "Acar", "Akın", "Ateş", "Bayram",
    "Can", "Çakmak", "Durmuş", "Ekici", "Gezer", "Güler", "Işık", "Kara",
    "Kartal", "Keskin", "Köse", "Mutlu", "Özer", "Sağlam", "Sezer", "Soylu",
    "Taş", "Toprak", "Tuna", "Uysal", "Ünal", "Yaman", "Yiğit", "Zengin",
    "Akbulut", "Akgün", "Altın", "Atalay", "Bakır", "Bayraktar", "Ceylan",
    "Dağ", "Ekinci", "Gökçe", "Karadağ", "Özbay", "Pektaş", "Solak", "Tan",
    "Silva", "Santos", "García", "Fernández", "Smith", "Jones", "Müller",
    "Schmidt", "Rossi", "Russo", "Martin", "Bernard", "González", "Rodríguez",
  ];
  const p = String(pos || "").toUpperCase();
  const isGk = p === "GK";
  // Ana özellikler (mevkiye göre primary sayılır)
  const primary = {
    pace: ["FL", "FR", "ML", "MR", "DL", "DR"].includes(p),
    passing: ["MC", "OMC", "DM", "ML", "MR"].includes(p),
    finishing: ["FC", "FL", "FR", "OMC"].includes(p),
    tackle: ["DC", "DL", "DR", "DM"].includes(p),
    vision: ["MC", "OMC", "DM"].includes(p),
    stamina: ["DM", "MC", "DC", "DL", "DR"].includes(p),
    strength: ["DC", "FC", "DM"].includes(p),
    technique: ["OMC", "MC", "FL", "FR", "FC"].includes(p),
    agility: isGk || ["FL", "FR", "ML", "MR"].includes(p),
    positioning: isGk || ["DC", "DL", "DR", "DM", "FC"].includes(p),
    reflex: isGk,
    handling: isGk,
  };
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
    pace: sk(mods.pace, primary.pace),
    passing: sk(mods.passing, primary.passing),
    finishing: sk(mods.finishing, primary.finishing),
    tackle: sk(mods.tackle, primary.tackle),
    vision: sk(mods.vision, primary.vision),
    stamina: sk(mods.stamina, primary.stamina),
    strength: sk(mods.strength, primary.strength),
    technique: sk(mods.technique, primary.technique),
    agility: sk(mods.agility, primary.agility),
    positioning: sk(mods.positioning, primary.positioning),
    reflex: isGk ? sk(mods.reflex, true) : clampSkill(4 + Math.random() * 3),
    handling: isGk ? sk(mods.handling, true) : clampSkill(3 + Math.random() * 2.5),
    condition: 85 + Math.floor(Math.random() * 15),
    form: 0,
    experience: 2 + Math.random() * 5,
    happiness: 70 + Math.floor(Math.random() * 25),
    base_quality: Math.max(1, Math.min(10, Math.round(strength * 0.7 + Math.random() * 2.5))),
    base_potential: Math.max(1, Math.min(10, Math.round(strength * 0.85 + Math.random() * 2.5))),
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
  const targetSize = Math.max(2, opts.targetSize || 8);
  const generateFixtures = opts.generateFixtures !== false;
  const forceFixtures = !!opts.forceFixtures;

  let current = await countClubs(country, division);
  const need = Math.max(0, targetSize - current);
  const created = [];
  const removed = [];

  // Fazla bot varsa hedefe indir (insan kulüplere dokunma)
  if (current > targetSize) {
    const excess = current - targetSize;
    const { rows: excessBots } = await query(
      `SELECT id, name FROM clubs
       WHERE country = $1 AND division = $2 AND COALESCE(is_bot, FALSE) = TRUE
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT $3`,
      [country, division, excess],
    );
    for (const b of excessBots) {
      try {
        await query(`UPDATE players SET club_id = NULL WHERE club_id = $1`, [b.id]);
        await query(`DELETE FROM league_standings WHERE club_id = $1`, [b.id]).catch(() => {});
        await query(`DELETE FROM clubs WHERE id = $1 AND COALESCE(is_bot, FALSE) = TRUE`, [b.id]);
        removed.push({ id: b.id, name: b.name });
      } catch (e) {
        console.warn("[botClubs] prune bot", b.id, e && e.message);
      }
    }
    current = await countClubs(country, division);
  }

  for (let i = 0; i < need; i++) {
    const strength = 3 + Math.floor(Math.random() * 5);
    const bot = await createBotClub({ country, division, strength });
    created.push(bot);
  }

  // Ülkenin bu ligi için aktif sezon yoksa otomatik açılır (yalnızca
  // Türkiye başlangıçta seed edilmişti — diğer ülkeler ilk kayıtta burada
  // sezona kavuşur, aksi halde standings/fikstür hiç oluşmuyordu).
  const season = await leagueRepo.ensureSeason(country, division);
  if (season) {
    const { rows: clubs } = await query(
      `SELECT id FROM clubs WHERE country = $1 AND division = $2`,
      [country, division],
    );
    for (const c of clubs) {
      await leagueRepo.ensureClubInStandings(season.id, c.id);
    }

    if (generateFixtures && (need > 0 || removed.length > 0 || forceFixtures)) {
      // forceFixtures yalnızca açıkça true ise fikstürü siler/yeniler.
      // need > 0 (yeni bot) → force YOK: fikstür yoksa üretir, varsa dokunmaz.
      const fx = await leagueRepo.generateFixturesForSeason(season.id, {
        force: !!forceFixtures,
        intervalHours: opts.intervalHours,
        intervalMinutes: opts.intervalMinutes,
        doubleRound: opts.doubleRound !== false,
        startAt: opts.startAt, // yoksa seasonConfig (10.08.2026)
        bumpPast: opts.bumpPast === true,
      });
      return {
        created: created.length,
        removed: removed.length,
        removedBots: removed,
        bots: created,
        totalClubs: current + created.length,
        fixtures: fx,
        seasonId: season.id,
      };
    }
  }

  return {
    created: created.length,
    removed: removed.length,
    removedBots: removed,
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

/**
 * Mevcut kulübün tüm oyuncularını silip 18 kişilik yeni kadro verir.
 * strength 1–10 (insan kulüpleri için ~5–7).
 */
async function regenerateSquad(clubId, strength = 5) {
  const s = Math.max(1, Math.min(10, Number(strength) || 5));
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM players WHERE club_id = $1`, [clubId]);
    for (let i = 0; i < POSITIONS_18.length; i++) {
      const p = makePlayer(clubId, POSITIONS_18[i], i, s);
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
    return { clubId, players: POSITIONS_18.length, strength: s };
  });
}

/** Tüm kulüpler için kadro yenile (insan + bot). */
async function regenerateAllSquads() {
  const { rows } = await query(
    `SELECT id, COALESCE(is_bot, FALSE) AS is_bot, balance FROM clubs`,
  );
  const out = [];
  for (const c of rows) {
    let strength = 5;
    if (c.is_bot) {
      // bakiye ~ strength tahmini
      strength = Math.max(3, Math.min(9, Math.round(Number(c.balance) / 200000 - 5)));
    } else {
      strength = 5 + Math.floor(Math.random() * 3);
    }
    try {
      out.push(await regenerateSquad(c.id, strength));
    } catch (e) {
      console.warn("[regenerateSquad]", c.id, e.message);
    }
  }
  return { clubs: out.length, details: out };
}

module.exports = {
  createBotClub,
  ensureLeagueFilled,
  countClubs,
  countHumanClubs,
  getBotTeam,
  makePlayer,
  regenerateSquad,
  regenerateAllSquads,
};
