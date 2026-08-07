-- ============================================================
-- Elite Manager Online — Migration 002: register_club helper
-- Yeni kullanıcı kaydında kulüp + stadyum + akademi + antrenör
-- + basit 18 kişilik kadro seed eder.
--
-- Kullanım (Node tarafında transaction içinde):
--   SELECT * FROM register_new_club($userId, $username, $teamName);
-- ============================================================


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
  v_skill REAL;
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

  -- Opening balance ledger
  INSERT INTO finance_ledger (club_id, amount, label)
  VALUES (v_club_id, 5000000, 'Başlangıç kasası');

  -- 18 players: first 11 starters
  FOR v_i IN 1..18 LOOP
    v_pos := v_positions[v_i];
    v_skill := 8 + random() * 6;
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
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      v_skill + (random()-0.5)*2,
      85 + floor(random() * 15)::INT,
      3 + floor(random() * 5)::INT,
      4 + floor(random() * 5)::INT,
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

