// ============================================================
// matchI18n.js — Maç motoru log metinleri
// Diller: tr + en + 5 büyük futbol ülkesi (es, de, it, pt, fr)
// ============================================================

const SUPPORTED = ["tr", "en", "es", "de", "it", "pt", "fr"];

const DICT = {
  match_start: {
    tr: "⚽ Maç başladı!",
    en: "⚽ Kick-off!",
    es: "⚽ ¡Comienza el partido!",
    de: "⚽ Anpfiff!",
    it: "⚽ Inizio partita!",
    pt: "⚽ Começa o jogo!",
    fr: "⚽ Coup d'envoi !",
  },
  match_end: {
    tr: "🏁 Maç bitti: {home} {hs} - {as} {away}",
    en: "🏁 Full time: {home} {hs} - {as} {away}",
    es: "🏁 Final: {home} {hs} - {as} {away}",
    de: "🏁 Abpfiff: {home} {hs} - {as} {away}",
    it: "🏁 Fine partita: {home} {hs} - {as} {away}",
    pt: "🏁 Fim de jogo: {home} {hs} - {as} {away}",
    fr: "🏁 Fin du match : {home} {hs} - {as} {away}",
  },
  goal: {
    tr: "⚽ GOL! {scorer}{assist} ({min}') — {hs}-{as}",
    en: "⚽ GOAL! {scorer}{assist} ({min}') — {hs}-{as}",
    es: "⚽ ¡GOL! {scorer}{assist} ({min}') — {hs}-{as}",
    de: "⚽ TOR! {scorer}{assist} ({min}') — {hs}-{as}",
    it: "⚽ GOL! {scorer}{assist} ({min}') — {hs}-{as}",
    pt: "⚽ GOL! {scorer}{assist} ({min}') — {hs}-{as}",
    fr: "⚽ BUT ! {scorer}{assist} ({min}') — {hs}-{as}",
  },
  assist: {
    tr: " (Asist: {name})",
    en: " (Assist: {name})",
    es: " (Asistencia: {name})",
    de: " (Vorlage: {name})",
    it: " (Assist: {name})",
    pt: " (Assistência: {name})",
    fr: " (Passe décisive : {name})",
  },
  shot_wide: {
    tr: "Şut auta gitti ({name})",
    en: "Shot goes wide ({name})",
    es: "Tiro fuera ({name})",
    de: "Schuss daneben ({name})",
    it: "Tiro fuori ({name})",
    pt: "Remate para fora ({name})",
    fr: "Tir à côté ({name})",
  },
  shot_blocked: {
    tr: "Şut bloklandı ({name})",
    en: "Shot blocked ({name})",
    es: "Tiro bloqueado ({name})",
    de: "Schuss geblockt ({name})",
    it: "Tiro bloccato ({name})",
    pt: "Remate bloqueado ({name})",
    fr: "Tir bloqué ({name})",
  },
  shot_post: {
    tr: "Şut direğin yanından ({name})",
    en: "Shot just past the post ({name})",
    es: "Tiro rozando el poste ({name})",
    de: "Schuss knapp am Pfosten vorbei ({name})",
    it: "Tiro a lato del palo ({name})",
    pt: "Remate ao lado do poste ({name})",
    fr: "Tir près du poteau ({name})",
  },
  save: {
    tr: "Kurtarış! {gk} ({name} şutu)",
    en: "Save! {gk} (shot by {name})",
    es: "¡Parada! {gk} (tiro de {name})",
    de: "Parade! {gk} (Schuss von {name})",
    it: "Parata! {gk} (tiro di {name})",
    pt: "Defesa! {gk} (remate de {name})",
    fr: "Arrêt ! {gk} (tir de {name})",
  },
  shot_gk: {
    tr: "Şut kalecide ({name})",
    en: "Shot saved by keeper ({name})",
    es: "Tiro al portero ({name})",
    de: "Schuss auf den Torwart ({name})",
    it: "Tiro sul portiere ({name})",
    pt: "Remate no guarda-redes ({name})",
    fr: "Tir sur le gardien ({name})",
  },
  yellow: {
    tr: "Sarı kart: {name}",
    en: "Yellow card: {name}",
    es: "Tarjeta amarilla: {name}",
    de: "Gelbe Karte: {name}",
    it: "Cartellino giallo: {name}",
    pt: "Cartão amarelo: {name}",
    fr: "Carton jaune : {name}",
  },
  red: {
    tr: "Kırmızı kart: {name}",
    en: "Red card: {name}",
    es: "Tarjeta roja: {name}",
    de: "Rote Karte: {name}",
    it: "Cartellino rosso: {name}",
    pt: "Cartão vermelho: {name}",
    fr: "Carton rouge : {name}",
  },
  second_yellow: {
    tr: "İkinci sarı → kırmızı: {name}",
    en: "Second yellow → red: {name}",
    es: "Segunda amarilla → roja: {name}",
    de: "Gelb-Rot: {name}",
    it: "Doppia ammonizione → rosso: {name}",
    pt: "Segundo amarelo → vermelho: {name}",
    fr: "Deuxième jaune → rouge : {name}",
  },
  injury: {
    tr: "Sakatlık: {name}",
    en: "Injury: {name}",
    es: "Lesión: {name}",
    de: "Verletzung: {name}",
    it: "Infortunio: {name}",
    pt: "Lesão: {name}",
    fr: "Blessure : {name}",
  },
  tactic_change: {
    tr: "{min}' {user} taktik değiştirdi.",
    en: "{min}' {user} changed tactics.",
    es: "{min}' {user} cambió la táctica.",
    de: "{min}' {user} hat die Taktik geändert.",
    it: "{min}' {user} ha cambiato tattica.",
    pt: "{min}' {user} mudou a tática.",
    fr: "{min}' {user} a changé de tactique.",
  },
  sub: {
    tr: "{min}' Değişiklik ({user}): {out} çıktı, {inn} girdi.",
    en: "{min}' Substitution ({user}): {out} off, {inn} on.",
    es: "{min}' Cambio ({user}): sale {out}, entra {inn}.",
    de: "{min}' Wechsel ({user}): {out} raus, {inn} rein.",
    it: "{min}' Sostituzione ({user}): esce {out}, entra {inn}.",
    pt: "{min}' Substituição ({user}): sai {out}, entra {inn}.",
    fr: "{min}' Remplacement ({user}) : sort {out}, entre {inn}.",
  },
  turnover: {
    tr: "{team} topu kazandı.",
    en: "{team} wins the ball.",
    es: "{team} recupera el balón.",
    de: "{team} erobert den Ball.",
    it: "{team} conquista il pallone.",
    pt: "{team} recupera a bola.",
    fr: "{team} récupère le ballon.",
  },
  half_time: {
    tr: "45' Devre Arası / İkinci Yarı Başladı!",
    en: "45' Half-time / Second half begins!",
    es: "45' Descanso / ¡Comienza la segunda parte!",
    de: "45' Halbzeit / Zweite Hälfte beginnt!",
    it: "45' Intervallo / Inizia il secondo tempo!",
    pt: "45' Intervalo / Começa a segunda parte!",
    fr: "45' Mi-temps / Début de la seconde période !",
  },
  pen_goal: {
    tr: "{min}' PENALTI GOLÜ! {name}",
    en: "{min}' PENALTY GOAL! {name}",
    es: "{min}' ¡GOL DE PENALTI! {name}",
    de: "{min}' ELFMETERTOR! {name}",
    it: "{min}' GOL SU RIGORE! {name}",
    pt: "{min}' GOL DE PENÁLTI! {name}",
    fr: "{min}' BUT SUR PÉNALTY ! {name}",
  },
  shot_out: {
    tr: "{min}' ŞUT AUTA ÇIKTI! {name}",
    en: "{min}' SHOT GOES OUT! {name}",
    es: "{min}' ¡TIRO FUERA! {name}",
    de: "{min}' SCHUSS INS AUS! {name}",
    it: "{min}' TIRO FUORI! {name}",
    pt: "{min}' REMATE PARA FORA! {name}",
    fr: "{min}' TIR EN DEHORS ! {name}",
  },
  var_start: {
    tr: "📺 VAR İncelemesi başladı ({team})...",
    en: "📺 VAR check started ({team})...",
    es: "📺 Revisión VAR iniciada ({team})...",
    de: "📺 VAR-Überprüfung gestartet ({team})...",
    it: "📺 Controllo VAR iniziato ({team})...",
    pt: "📺 Revisão do VAR iniciada ({team})...",
    fr: "📺 Vérification VAR lancée ({team})...",
  },
  var_goal: {
    tr: "✅ VAR KARARI: Gol onaylandı, sayılıyor!",
    en: "✅ VAR DECISION: Goal confirmed!",
    es: "✅ DECISIÓN VAR: ¡Gol confirmado!",
    de: "✅ VAR-ENTSCHEIDUNG: Tor bestätigt!",
    it: "✅ DECISIONE VAR: Gol confermato!",
    pt: "✅ DECISÃO DO VAR: Golo confirmado!",
    fr: "✅ DÉCISION VAR : But confirmé !",
  },
  var_no_goal: {
    tr: "❌ VAR KARARI: Gol iptal!",
    en: "❌ VAR DECISION: Goal disallowed!",
    es: "❌ DECISIÓN VAR: ¡Gol anulado!",
    de: "❌ VAR-ENTSCHEIDUNG: Tor aberkannt!",
    it: "❌ DECISIONE VAR: Gol annullato!",
    pt: "❌ DECISÃO DO VAR: Golo anulado!",
    fr: "❌ DÉCISION VAR : But refusé !",
  },
  corner: {
    tr: "{min}' Korner — {team} ({name})",
    en: "{min}' Corner — {team} ({name})",
    es: "{min}' Córner — {team} ({name})",
    de: "{min}' Ecke — {team} ({name})",
    it: "{min}' Corner — {team} ({name})",
    pt: "{min}' Canto — {team} ({name})",
    fr: "{min}' Corner — {team} ({name})",
  },
  corner_cleared: {
    tr: "Korner uzaklaştırıldı ({team})",
    en: "Corner cleared ({team})",
    es: "Córner despejado ({team})",
    de: "Ecke geklärt ({team})",
    it: "Corner allontanato ({team})",
    pt: "Canto afastado ({team})",
    fr: "Corner dégagé ({team})",
  },
  corner_goal: {
    tr: "⚽ KORNER GOLÜ! {name} ({min}') — {hs}-{as}",
    en: "⚽ CORNER GOAL! {name} ({min}') — {hs}-{as}",
    es: "⚽ ¡GOL DE CÓRNER! {name} ({min}') — {hs}-{as}",
    de: "⚽ TOR NACH ECKE! {name} ({min}') — {hs}-{as}",
    it: "⚽ GOL SU CORNER! {name} ({min}') — {hs}-{as}",
    pt: "⚽ GOL DE CANTO! {name} ({min}') — {hs}-{as}",
    fr: "⚽ BUT SUR CORNER ! {name} ({min}') — {hs}-{as}",
  },
  freekick: {
    tr: "{min}' Serbest vuruş ({name})",
    en: "{min}' Free kick ({name})",
    es: "{min}' Tiro libre ({name})",
    de: "{min}' Freistoß ({name})",
    it: "{min}' Calcio di punizione ({name})",
    pt: "{min}' Livre ({name})",
    fr: "{min}' Coup franc ({name})",
  },
  freekick_goal: {
    tr: "⚽ SERBEST VURUŞ GOLÜ! {name} ({min}') — {hs}-{as}",
    en: "⚽ FREE-KICK GOAL! {name} ({min}') — {hs}-{as}",
    es: "⚽ ¡GOL DE FALTA! {name} ({min}') — {hs}-{as}",
    de: "⚽ FREISTOSSTOR! {name} ({min}') — {hs}-{as}",
    it: "⚽ GOL SU PUNIZIONE! {name} ({min}') — {hs}-{as}",
    pt: "⚽ GOL DE LIVRE! {name} ({min}') — {hs}-{as}",
    fr: "⚽ BUT SUR COUP FRANC ! {name} ({min}') — {hs}-{as}",
  },
  penalty: {
    tr: "{min}' PENALTI! ({name})",
    en: "{min}' PENALTY! ({name})",
    es: "{min}' ¡PENALTI! ({name})",
    de: "{min}' ELFMETER! ({name})",
    it: "{min}' RIGORE! ({name})",
    pt: "{min}' PENÁLTI! ({name})",
    fr: "{min}' PÉNALTY ! ({name})",
  },
  penalty_miss: {
    tr: "Penaltı kaçtı! {name} — {gk} kurtardı / aut",
    en: "Penalty missed! {name} — {gk} saves / wide",
    es: "¡Penalti fallado! {name} — {gk}",
    de: "Elfmeter vergeben! {name} — {gk}",
    it: "Rigore sbagliato! {name} — {gk}",
    pt: "Penálti falhado! {name} — {gk}",
    fr: "Pénalty manqué ! {name} — {gk}",
  },
};

function normalizeLang(lang) {
  const l = String(lang || "en").toLowerCase().slice(0, 2);
  if (SUPPORTED.indexOf(l) >= 0) return l;
  return "en";
}

function mt(key, lang, vars) {
  const l = normalizeLang(lang);
  const row = DICT[key];
  if (!row) return key;
  let s = row[l] || row.en || row.tr || key;
  if (vars) {
    Object.keys(vars).forEach(function (k) {
      s = s.split("{" + k + "}").join(String(vars[k] != null ? vars[k] : ""));
    });
  }
  return s;
}

module.exports = { mt, normalizeLang, SUPPORTED, DICT };
