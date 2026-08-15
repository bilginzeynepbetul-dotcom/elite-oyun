-- ============================================================
-- Elite Manager Online — Migration 002: register_club helper
-- Yeni kullanıcı kaydında kulüp + stadyum + akademi + antrenör
-- + mevkiye duyarlı 18 kişilik kadro seed eder.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION register_new_club(
  p_user_id   UUID,
  p_username  TEXT,
  p_team_name TEXT DEFAULT NULL
)
RETURNS TABLE (club_id UUID, season_id INT) AS $$
DECLARE
  v_club_id   UUID;
  v_name      TEXT;
  v_season_id INT;
  v_positions TEXT[] := ARRAY[
    'GK','DL','DC','DC','DR','DM','MC','MC','OMC','FL','FR',
    'GK','DC','MC','FC','ML','MR','DM'
  ];
  v_pos TEXT;
  v_i INT;
  v_base REAL;
  -- helpers inline via expressions below
BEGIN
  v_name := COALESCE(NULLIF(TRIM(p_team_name), ''), p_username || ' SK');

  INSERT INTO clubs (user_id, name)
  VALUES (p_user_id, v_name)
  RETURNING id INTO v_club_id;

  INSERT INTO stadiums (club_id, name, capacity, ticket_price)
  VALUES (v_club_id, v_name || ' Arena', 24500, 12);

  INSERT INTO youth_academy (club_id)
  VALUES (v_club_id);

  INSERT INTO club_coaches (club_id, skill, level, salary, name)
  VALUES (v_club_id, 'stamina', 1, 8000, 'Dayanıklılık Antrenörü');

  INSERT INTO finance_ledger (club_id, amount, label)
  VALUES (v_club_id, 5000000, 'Başlangıç kasası');

  -- 18 players: first 11 starters — mevkiye göre ana skill yüksek, diğerleri düşük-orta
  FOR v_i IN 1..18 LOOP
    v_pos := v_positions[v_i];
    v_base := 6.5 + random() * 2.5; -- genel tavan düşük-orta
    INSERT INTO players (
      club_id, name, number, pos, natural_pos, age,
      pace, passing, finishing, tackle, vision, stamina,
      strength, technique, agility, positioning, reflex, handling,
      condition, base_quality, base_potential,
      is_starter, bench_order
    ) VALUES (
      v_club_id,
      (ARRAY['Can','Emre','Burak','Arda','Kerem','Yusuf','Mert','Ozan','Hakan','Cenk',
             'Yiğit','Efe','Alp','Kaan','Deniz','Baran','Emir','Umut'])[v_i]
        || ' ' ||
      (ARRAY['Yılmaz','Demir','Kaya','Çelik','Şahin','Aydın','Öztürk','Arslan',
             'Doğan','Kılıç','Koç','Polat','Aslan','Kurt','Yıldız','Özkan','Ergün','Aksoy'])[v_i],
      v_i,
      v_pos,
      v_pos,
      18 + floor(random() * 12)::INT,
      -- pace
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'GK' THEN -2.0 WHEN 'FL' THEN 2.2 WHEN 'FR' THEN 2.2
        WHEN 'ML' THEN 1.5 WHEN 'MR' THEN 1.5 WHEN 'DL' THEN 1.2 WHEN 'DR' THEN 1.2
        WHEN 'FC' THEN 0.7 WHEN 'DC' THEN -0.7 ELSE 0.2 END + (random()-0.5)*2)),
      -- passing
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'GK' THEN -0.8 WHEN 'MC' THEN 2.2 WHEN 'OMC' THEN 2.4 WHEN 'DM' THEN 1.3
        WHEN 'ML' THEN 1.1 WHEN 'MR' THEN 1.1 WHEN 'FC' THEN -0.3 ELSE 0.2 END + (random()-0.5)*2)),
      -- finishing
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'GK' THEN -3.5 WHEN 'FC' THEN 3.0 WHEN 'FL' THEN 1.4 WHEN 'FR' THEN 1.4
        WHEN 'OMC' THEN 1.1 WHEN 'DC' THEN -2.5 WHEN 'DM' THEN -1.8 ELSE -0.8 END + (random()-0.5)*2)),
      -- tackle
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'GK' THEN -2.0 WHEN 'DC' THEN 2.8 WHEN 'DL' THEN 2.0 WHEN 'DR' THEN 2.0
        WHEN 'DM' THEN 2.2 WHEN 'FC' THEN -1.8 WHEN 'FL' THEN -1.4 WHEN 'FR' THEN -1.4
        ELSE 0.3 END + (random()-0.5)*2)),
      -- vision
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'GK' THEN -0.5 WHEN 'OMC' THEN 2.5 WHEN 'MC' THEN 2.0 WHEN 'DM' THEN 0.7
        WHEN 'ML' THEN 0.7 WHEN 'MR' THEN 0.7 ELSE 0.1 END + (random()-0.5)*2)),
      -- stamina
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'GK' THEN -0.4 WHEN 'DM' THEN 1.4 WHEN 'MC' THEN 1.2 WHEN 'DC' THEN 1.0
        ELSE 0.7 END + (random()-0.5)*2)),
      -- strength
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'DC' THEN 2.2 WHEN 'FC' THEN 1.6 WHEN 'DM' THEN 1.1 WHEN 'GK' THEN 0.3
        WHEN 'FL' THEN -0.5 WHEN 'FR' THEN -0.5 ELSE 0.2 END + (random()-0.5)*2)),
      -- technique
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'OMC' THEN 2.0 WHEN 'MC' THEN 1.4 WHEN 'FL' THEN 1.4 WHEN 'FR' THEN 1.4
        WHEN 'FC' THEN 1.2 WHEN 'GK' THEN -0.4 ELSE 0.2 END + (random()-0.5)*2)),
      -- agility
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'GK' THEN 1.2 WHEN 'FL' THEN 2.0 WHEN 'FR' THEN 2.0 WHEN 'ML' THEN 1.5
        WHEN 'MR' THEN 1.5 WHEN 'DC' THEN -0.5 ELSE 0.3 END + (random()-0.5)*2)),
      -- positioning
      GREATEST(4, LEAST(16, v_base + CASE v_pos
        WHEN 'GK' THEN 2.0 WHEN 'DC' THEN 2.8 WHEN 'DL' THEN 1.6 WHEN 'DR' THEN 1.6
        WHEN 'DM' THEN 1.4 WHEN 'FC' THEN 1.4 ELSE 0.5 END + (random()-0.5)*2)),
      -- reflex
      GREATEST(4, LEAST(16, CASE WHEN v_pos = 'GK'
        THEN v_base + 3.8 + (random()-0.5)*1.6
        ELSE 4 + random() * 3 END)),
      -- handling
      GREATEST(3, LEAST(16, CASE WHEN v_pos = 'GK'
        THEN v_base + 3.6 + (random()-0.5)*1.6
        ELSE 3 + random() * 2.5 END)),
      85 + floor(random() * 15)::INT,
      2 + floor(random() * 4)::INT,
      3 + floor(random() * 5)::INT,
      (v_i <= 11),
      CASE WHEN v_i > 11 THEN v_i - 11 ELSE NULL END
    );
  END LOOP;

  SELECT s.id INTO v_season_id
  FROM seasons s
  WHERE s.country = 'Türkiye' AND s.division = 1 AND s.is_current
  ORDER BY s.id DESC
  LIMIT 1;

  IF v_season_id IS NOT NULL THEN
    INSERT INTO league_standings (season_id, club_id)
    VALUES (v_season_id, v_club_id)
    ON CONFLICT DO NOTHING;
  END IF;

  club_id := v_club_id;
  season_id := v_season_id;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

COMMIT;
