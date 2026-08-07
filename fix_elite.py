import re

# Dosyayı oku
with open('elite_manager.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. applyFormationPreset fonksiyonunu değiştir
old_apply = '''function applyFormationPreset(side, key) {
  if (matchStarted) {
    addLog('Maç başladıktan sonra diziliş değiştirilemez.', "tactics-log");
    return;
  }
  const template = FORMATION_PRESETS[key];
  if (!template) return;
  const team = teamConfig[side];
  const isHome = side === 'home';
  const slots = template.map(s => ({ pos: s.pos, x: isHome ? s.x : (600 - s.x), y: s.y }));

  const gk = team.players.find(p => (p.naturalPos || p.pos) === 'GK') || team.players[0];
  const outfield = team.players.filter(p => p !== gk);
  const rank = { DF: 0, MC: 1, ST: 2 };
  outfield.sort((a, b) => (rank[a.naturalPos || a.pos] ?? 1) - (rank[b.naturalPos || b.pos] ?? 1));

  const newOrder = [gk, ...outfield];
  newOrder.forEach((p, i) => {
    const slot = slots[i];
    if (!slot || !p) return;
    p.x = slot.x; p.y = slot.y; p.pos = slot.pos;
  });
  team.players = newOrder;
  team.currentFormation = key;

  document.querySelectorAll('.formation-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.formation === key));
  addLog(team.name + ': Diziliş ' + key + ' olarak ayarlandı.', "tactics-log");
  renderFormationPitch(side);
  renderFormationBench(side);
  populateSubSelects(side);
}'''

new_apply = '''function applyFormationPreset(side, key) {
  if (matchStarted) {
    addLog('Maç başladıktan sonra diziliş değiştirilemez.', "tactics-log");
    return;
  }
  const template = FORMATION_PRESETS[key];
  if (!template) return;
  const team = teamConfig[side];
  const isHome = side === 'home';
  const allPlayers = [...team.players, ...(team.bench || [])];
  const neededPositions = template.map(s => s.pos);
  const newStarters = [];
  const usedIds = new Set();
  
  const gk = allPlayers.find(p => (p.naturalPos || p.pos) === 'GK' && !usedIds.has(p.id));
  if (gk) { usedIds.add(gk.id); newStarters.push(gk); }
  
  ['DF', 'MC', 'ST'].forEach(pos => {
    const countNeeded = neededPositions.filter(p => p === pos).length;
    const candidates = allPlayers.filter(p => (p.naturalPos || p.pos) === pos && !usedIds.has(p.id))
      .sort((a, b) => calculatePlayerQuality(b) - calculatePlayerQuality(a));
    for (let i = 0; i < countNeeded && i < candidates.length; i++) {
      usedIds.add(candidates[i].id);
      newStarters.push(candidates[i]);
    }
  });
  
  while (newStarters.length < 11 && allPlayers.length > newStarters.length) {
    const filler = allPlayers.find(p => !usedIds.has(p.id));
    if (filler) { usedIds.add(filler.id); newStarters.push(filler); } else break;
  }
  
  const newBench = allPlayers.filter(p => !usedIds.has(p.id));
  const slots = template.map(s => ({ pos: s.pos, x: isHome ? s.x : (600 - s.x), y: s.y }));
  
  newStarters.forEach((p, i) => {
    if (slots[i] && p) { p.x = slots[i].x; p.y = slots[i].y; p.pos = slots[i].pos; }
  });
  
  team.players = newStarters.slice(0, 11);
  team.bench = newBench;
  team.currentFormation = key;
  
  document.querySelectorAll('.formation-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.formation === key));
  addLog(team.name + ': Diziliş ' + key + ' olarak ayarlandı. ' + team.players.length + ' oyuncu sahada, ' + team.bench.length + ' yedek.', "tactics-log");
  renderFormationPitch(side);
  renderFormationBench(side);
  populateSubSelects(side);
}'''

content = content.replace(old_apply, new_apply)

# 2. renderFormationBench fonksiyonunu değiştir
old_bench = '''function renderFormationBench(side) {
  const team = teamConfig[side];
  const container = document.getElementById('formationBenchList');
  container.innerHTML = '';
  if (!team.bench || team.bench.length === 0) {
    container.innerHTML = '<div style="color:#64748b;font-size:11px;padding:4px 0;">Yedek kulübesi boş.</div>';
  } else {
    team.bench.forEach((p, idx) => {
      const chip = document.createElement('div');
      chip.className = 'formation-bench-item';
      chip.innerText = p.number + ' ' + p.name + ' (' + p.pos + ')';
      chip.draggable = !matchStarted;
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'bench', index: idx }));
      });
      container.appendChild(chip);
    });
  }
  document.getElementById('subsMaxInput').value = team.subsMax;
}'''

new_bench = '''function renderFormationBench(side) {
  const team = teamConfig[side];
  const container = document.getElementById('formationBenchList');
  container.innerHTML = '<div style="width:100%;font-size:10px;color:#94a3b8;margin-bottom:4px;text-align:center;">📋 Tüm Kadro (' + (team.bench?.length || 0) + ' yedek) — Sürükleyip sahaya atabilirsin</div>';
  if (!team.bench || team.bench.length === 0) {
    container.innerHTML += '<div style="color:#64748b;font-size:11px;padding:4px 0;">Yedek kulübesi boş.</div>';
  } else {
    team.bench.forEach((p, idx) => {
      const chip = document.createElement('div');
      chip.className = 'formation-bench-item';
      chip.innerText = p.number + ' ' + p.name + ' (' + (p.naturalPos || p.pos) + ')';
      chip.style.borderLeft = '3px solid ' + (p.naturalPos === 'GK' ? '#ca8a04' : p.naturalPos === 'DF' ? '#1d4ed8' : p.naturalPos === 'MC' ? '#0891b2' : '#dc2626');
      chip.draggable = !matchStarted;
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'bench', index: idx }));
      });
      container.appendChild(chip);
    });
  }
  document.getElementById('subsMaxInput').value = team.subsMax;
}'''

content = content.replace(old_bench, new_bench)

# 3. Maç içi panel HTML'ini ekle (prematch-actions ile ratings-panel arasına)
panel_html = '''</div>

<div id="inmatch-tactics-panel" style="display:none; width:624px; margin-top:16px; background:linear-gradient(160deg, #1e293b 0%, #17202f 100%); border:1px solid #2c3a52; padding:14px 20px; border-radius:14px; box-shadow:0 15px 30px rgba(0,0,0,0.45);">
  <div class="tactics-title">⚡ Maç İçi Taktik Değişikliği</div>
  <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; margin-bottom:10px;">
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Pas Stili</div>
      <select id="inmatchPassStyle" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;">
        <option value="kisa">Kısa Pas</option>
        <option value="uzun">Uzun Pas</option>
        <option value="hizli">Hızlı Pas</option>
      </select>
    </div>
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Oyun Stili</div>
      <select id="inmatchGameStyle" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;">
        <option value="normal">Normal</option>
        <option value="hücumsel">Hücum</option>
        <option value="defansif">Defans</option>
      </select>
    </div>
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Hücum Yönü</div>
      <select id="inmatchAttackDir" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;">
        <option value="orta">Orta</option>
        <option value="sol">Sol Kanat</option>
        <option value="sag">Sağ Kanat</option>
        <option value="hücum">Tam Hücum</option>
        <option value="geri">Geri Çekil</option>
      </select>
    </div>
  </div>
  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:10px; padding-top:10px; border-top:1px solid #2c3a52;">
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Çıkacak Oyuncu</div>
      <select id="inmatchOutSelect" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;"></select>
    </div>
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Girecek Oyuncu</div>
      <select id="inmatchInSelect" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;"></select>
    </div>
  </div>
  <div style="display:flex; gap:8px;">
    <button class="sub-btn" id="inmatchApplyTacticsBtn" style="flex:1;">Taktikleri Uygula</button>
    <button class="sub-btn" id="inmatchSubBtn" style="flex:1;background:linear-gradient(90deg, #22c55e, #16a34a);">Oyuncu Değiş</button>
  </div>
  <div id="inmatchTacticsNote" style="text-align:center;font-size:11px;color:#94a3b8;margin-top:8px;"></div>
</div>

<div id="ratings-panel">'''

content = content.replace('</div>\n\n<div id="ratings-panel">', panel_html, 1)

# 4. runMatchTick'e 60. dakika kontrolü ekle
old_tick_start = "  matchMinute++;\n  const minStr = matchMinute < 10 ? '0' + matchMinute : matchMinute;"
new_tick_start = """  // Maç içi taktik panelini 60. dakikada aç
  if (matchMinute === 60) {
    document.getElementById('inmatch-tactics-panel').style.display = 'block';
    populateInmatchSelects();
    addLog('60\\' Maç içi taktik değişikliği aktif! Pas stili, oyun stili ve oyuncu değişikliği yapabilirsin.', "tactics-log");
  }
  
  matchMinute++;
  const minStr = matchMinute < 10 ? '0' + matchMinute : matchMinute;"""

content = content.replace(old_tick_start, new_tick_start)

# 5. En alta yeni fonksiyonları ve event listener'ları ekle
extra_js = """

function populateInmatchSelects() {
  const team = teamConfig.home;
  const outSelect = document.getElementById('inmatchOutSelect');
  const inSelect = document.getElementById('inmatchInSelect');
  outSelect.innerHTML = '';
  inSelect.innerHTML = '';
  team.players.filter(p => !p.sentOff).forEach((p, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.innerText = p.number + ' ' + p.name + ' (' + p.pos + ') ' + Math.round(p.condition) + '%';
    outSelect.appendChild(opt);
  });
  (team.bench || []).forEach((p, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.innerText = p.number + ' ' + p.name + ' (' + (p.naturalPos || p.pos) + ')';
    inSelect.appendChild(opt);
  });
  const note = document.getElementById('inmatchTacticsNote');
  const subsLeft = team.subsMax - team.subsUsed;
  note.innerText = 'Kalan değişiklik: ' + subsLeft + ' | Kalan oyuncu: ' + (team.bench?.length || 0);
  document.getElementById('inmatchSubBtn').disabled = subsLeft <= 0 || !team.bench || team.bench.length === 0;
}

document.getElementById('inmatchApplyTacticsBtn').addEventListener('click', () => {
  const team = teamConfig.home;
  team.passStyle = document.getElementById('inmatchPassStyle').value;
  team.gameStyle = document.getElementById('inmatchGameStyle').value;
  team.attackDir = document.getElementById('inmatchAttackDir').value;
  addLog(matchMinute + '\\' Taktik güncellendi: ' + team.passStyle + ' pas | ' + team.gameStyle + ' | Yön: ' + team.attackDir, "tactics-log");
});

document.getElementById('inmatchSubBtn').addEventListener('click', () => {
  const team = teamConfig.home;
  if (team.subsUsed >= team.subsMax) return;
  const outIdx = parseInt(document.getElementById('inmatchOutSelect').value, 10);
  const inIdx = parseInt(document.getElementById('inmatchInSelect').value, 10);
  if (isNaN(outIdx) || isNaN(inIdx) || !team.bench || !team.bench[inIdx]) return;
  const outPlayer = team.players[outIdx];
  const inPlayer = team.bench.splice(inIdx, 1)[0];
  inPlayer.x = outPlayer.x;
  inPlayer.y = outPlayer.y;
  inPlayer.pos = outPlayer.pos;
  inPlayer.naturalPos = inPlayer.naturalPos || inPlayer.pos;
  inPlayer.minutesPlayed = 90 - matchMinute;
  inPlayer.condition = Math.min(100, inPlayer.condition + 5);
  outPlayer.minutesPlayed = matchMinute;
  team.players[outIdx] = inPlayer;
  team.subsUsed++;
  addLog(matchMinute + '\\' Değişiklik: ' + outPlayer.name + ' çıktı, ' + inPlayer.name + ' girdi!', "tactics-log");
  populateInmatchSelects();
});
"""

# En son </script> etiketinden önce ekle
content = content.replace('updateStatsDisplay();\nrender();\n</script>', 'updateStatsDisplay();\nrender();' + extra_js + '\n</script>')

# Yeni dosyaya kaydet
with open('elite_manager_v2.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("✅ elite_manager_v2.html oluşturuldu!")
print("🚀 Şimdi şu komutla çalıştır:")
print("   python -m http.server 8081 &")
print("   termux-open-url http://localhost:8081/elite_manager_v2.html")
import re

# Dosyayı oku
with open('elite_manager.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. applyFormationPreset fonksiyonunu değiştir
old_apply = '''function applyFormationPreset(side, key) {
  if (matchStarted) {
    addLog('Maç başladıktan sonra diziliş değiştirilemez.', "tactics-log");
    return;
  }
  const template = FORMATION_PRESETS[key];
  if (!template) return;
  const team = teamConfig[side];
  const isHome = side === 'home';
  const slots = template.map(s => ({ pos: s.pos, x: isHome ? s.x : (600 - s.x), y: s.y }));

  const gk = team.players.find(p => (p.naturalPos || p.pos) === 'GK') || team.players[0];
  const outfield = team.players.filter(p => p !== gk);
  const rank = { DF: 0, MC: 1, ST: 2 };
  outfield.sort((a, b) => (rank[a.naturalPos || a.pos] ?? 1) - (rank[b.naturalPos || b.pos] ?? 1));

  const newOrder = [gk, ...outfield];
  newOrder.forEach((p, i) => {
    const slot = slots[i];
    if (!slot || !p) return;
    p.x = slot.x; p.y = slot.y; p.pos = slot.pos;
  });
  team.players = newOrder;
  team.currentFormation = key;

  document.querySelectorAll('.formation-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.formation === key));
  addLog(team.name + ': Diziliş ' + key + ' olarak ayarlandı.', "tactics-log");
  renderFormationPitch(side);
  renderFormationBench(side);
  populateSubSelects(side);
}'''

new_apply = '''function applyFormationPreset(side, key) {
  if (matchStarted) {
    addLog('Maç başladıktan sonra diziliş değiştirilemez.', "tactics-log");
    return;
  }
  const template = FORMATION_PRESETS[key];
  if (!template) return;
  const team = teamConfig[side];
  const isHome = side === 'home';
  const allPlayers = [...team.players, ...(team.bench || [])];
  const neededPositions = template.map(s => s.pos);
  const newStarters = [];
  const usedIds = new Set();
  
  const gk = allPlayers.find(p => (p.naturalPos || p.pos) === 'GK' && !usedIds.has(p.id));
  if (gk) { usedIds.add(gk.id); newStarters.push(gk); }
  
  ['DF', 'MC', 'ST'].forEach(pos => {
    const countNeeded = neededPositions.filter(p => p === pos).length;
    const candidates = allPlayers.filter(p => (p.naturalPos || p.pos) === pos && !usedIds.has(p.id))
      .sort((a, b) => calculatePlayerQuality(b) - calculatePlayerQuality(a));
    for (let i = 0; i < countNeeded && i < candidates.length; i++) {
      usedIds.add(candidates[i].id);
      newStarters.push(candidates[i]);
    }
  });
  
  while (newStarters.length < 11 && allPlayers.length > newStarters.length) {
    const filler = allPlayers.find(p => !usedIds.has(p.id));
    if (filler) { usedIds.add(filler.id); newStarters.push(filler); } else break;
  }
  
  const newBench = allPlayers.filter(p => !usedIds.has(p.id));
  const slots = template.map(s => ({ pos: s.pos, x: isHome ? s.x : (600 - s.x), y: s.y }));
  
  newStarters.forEach((p, i) => {
    if (slots[i] && p) { p.x = slots[i].x; p.y = slots[i].y; p.pos = slots[i].pos; }
  });
  
  team.players = newStarters.slice(0, 11);
  team.bench = newBench;
  team.currentFormation = key;
  
  document.querySelectorAll('.formation-preset-btn').forEach(b => b.classList.toggle('active', b.dataset.formation === key));
  addLog(team.name + ': Diziliş ' + key + ' olarak ayarlandı. ' + team.players.length + ' oyuncu sahada, ' + team.bench.length + ' yedek.', "tactics-log");
  renderFormationPitch(side);
  renderFormationBench(side);
  populateSubSelects(side);
}'''

content = content.replace(old_apply, new_apply)

# 2. renderFormationBench fonksiyonunu değiştir
old_bench = '''function renderFormationBench(side) {
  const team = teamConfig[side];
  const container = document.getElementById('formationBenchList');
  container.innerHTML = '';
  if (!team.bench || team.bench.length === 0) {
    container.innerHTML = '<div style="color:#64748b;font-size:11px;padding:4px 0;">Yedek kulübesi boş.</div>';
  } else {
    team.bench.forEach((p, idx) => {
      const chip = document.createElement('div');
      chip.className = 'formation-bench-item';
      chip.innerText = p.number + ' ' + p.name + ' (' + p.pos + ')';
      chip.draggable = !matchStarted;
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'bench', index: idx }));
      });
      container.appendChild(chip);
    });
  }
  document.getElementById('subsMaxInput').value = team.subsMax;
}'''

new_bench = '''function renderFormationBench(side) {
  const team = teamConfig[side];
  const container = document.getElementById('formationBenchList');
  container.innerHTML = '<div style="width:100%;font-size:10px;color:#94a3b8;margin-bottom:4px;text-align:center;">📋 Tüm Kadro (' + (team.bench?.length || 0) + ' yedek) — Sürükleyip sahaya atabilirsin</div>';
  if (!team.bench || team.bench.length === 0) {
    container.innerHTML += '<div style="color:#64748b;font-size:11px;padding:4px 0;">Yedek kulübesi boş.</div>';
  } else {
    team.bench.forEach((p, idx) => {
      const chip = document.createElement('div');
      chip.className = 'formation-bench-item';
      chip.innerText = p.number + ' ' + p.name + ' (' + (p.naturalPos || p.pos) + ')';
      chip.style.borderLeft = '3px solid ' + (p.naturalPos === 'GK' ? '#ca8a04' : p.naturalPos === 'DF' ? '#1d4ed8' : p.naturalPos === 'MC' ? '#0891b2' : '#dc2626');
      chip.draggable = !matchStarted;
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'bench', index: idx }));
      });
      container.appendChild(chip);
    });
  }
  document.getElementById('subsMaxInput').value = team.subsMax;
}'''

content = content.replace(old_bench, new_bench)

# 3. Maç içi panel HTML'ini ekle (prematch-actions ile ratings-panel arasına)
panel_html = '''</div>

<div id="inmatch-tactics-panel" style="display:none; width:624px; margin-top:16px; background:linear-gradient(160deg, #1e293b 0%, #17202f 100%); border:1px solid #2c3a52; padding:14px 20px; border-radius:14px; box-shadow:0 15px 30px rgba(0,0,0,0.45);">
  <div class="tactics-title">⚡ Maç İçi Taktik Değişikliği</div>
  <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; margin-bottom:10px;">
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Pas Stili</div>
      <select id="inmatchPassStyle" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;">
        <option value="kisa">Kısa Pas</option>
        <option value="uzun">Uzun Pas</option>
        <option value="hizli">Hızlı Pas</option>
      </select>
    </div>
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Oyun Stili</div>
      <select id="inmatchGameStyle" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;">
        <option value="normal">Normal</option>
        <option value="hücumsel">Hücum</option>
        <option value="defansif">Defans</option>
      </select>
    </div>
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Hücum Yönü</div>
      <select id="inmatchAttackDir" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;">
        <option value="orta">Orta</option>
        <option value="sol">Sol Kanat</option>
        <option value="sag">Sağ Kanat</option>
        <option value="hücum">Tam Hücum</option>
        <option value="geri">Geri Çekil</option>
      </select>
    </div>
  </div>
  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:10px; padding-top:10px; border-top:1px solid #2c3a52;">
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Çıkacak Oyuncu</div>
      <select id="inmatchOutSelect" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;"></select>
    </div>
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Girecek Oyuncu</div>
      <select id="inmatchInSelect" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;"></select>
    </div>
  </div>
  <div style="display:flex; gap:8px;">
    <button class="sub-btn" id="inmatchApplyTacticsBtn" style="flex:1;">Taktikleri Uygula</button>
    <button class="sub-btn" id="inmatchSubBtn" style="flex:1;background:linear-gradient(90deg, #22c55e, #16a34a);">Oyuncu Değiş</button>
  </div>
  <div id="inmatchTacticsNote" style="text-align:center;font-size:11px;color:#94a3b8;margin-top:8px;"></div>
</div>

<div id="ratings-panel">'''

content = content.replace('</div>\n\n<div id="ratings-panel">', panel_html, 1)

# 4. runMatchTick'e 60. dakika kontrolü ekle
old_tick_start = "  matchMinute++;\n  const minStr = matchMinute < 10 ? '0' + matchMinute : matchMinute;"
new_tick_start = """  // Maç içi taktik panelini 60. dakikada aç
  if (matchMinute === 60) {
    document.getElementById('inmatch-tactics-panel').style.display = 'block';
    populateInmatchSelects();
    addLog('60\\' Maç içi taktik değişikliği aktif! Pas stili, oyun stili ve oyuncu değişikliği yapabilirsin.', "tactics-log");
  }
  
  matchMinute++;
  const minStr = matchMinute < 10 ? '0' + matchMinute : matchMinute;"""

content = content.replace(old_tick_start, new_tick_start)

# 5. En alta yeni fonksiyonları ve event listener'ları ekle
extra_js = """

function populateInmatchSelects() {
  const team = teamConfig.home;
  const outSelect = document.getElementById('inmatchOutSelect');
  const inSelect = document.getElementById('inmatchInSelect');
  outSelect.innerHTML = '';
  inSelect.innerHTML = '';
  team.players.filter(p => !p.sentOff).forEach((p, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.innerText = p.number + ' ' + p.name + ' (' + p.pos + ') ' + Math.round(p.condition) + '%';
    outSelect.appendChild(opt);
  });
  (team.bench || []).forEach((p, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.innerText = p.number + ' ' + p.name + ' (' + (p.naturalPos || p.pos) + ')';
    inSelect.appendChild(opt);
  });
  const note = document.getElementById('inmatchTacticsNote');
  const subsLeft = team.subsMax - team.subsUsed;
  note.innerText = 'Kalan değişiklik: ' + subsLeft + ' | Kalan oyuncu: ' + (team.bench?.length || 0);
  document.getElementById('inmatchSubBtn').disabled = subsLeft <= 0 || !team.bench || team.bench.length === 0;
}

document.getElementById('inmatchApplyTacticsBtn').addEventListener('click', () => {
  const team = teamConfig.home;
  team.passStyle = document.getElementById('inmatchPassStyle').value;
  team.gameStyle = document.getElementById('inmatchGameStyle').value;
  team.attackDir = document.getElementById('inmatchAttackDir').value;
  addLog(matchMinute + '\\' Taktik güncellendi: ' + team.passStyle + ' pas | ' + team.gameStyle + ' | Yön: ' + team.attackDir, "tactics-log");
});

document.getElementById('inmatchSubBtn').addEventListener('click', () => {
  const team = teamConfig.home;
  if (team.subsUsed >= team.subsMax) return;
  const outIdx = parseInt(document.getElementById('inmatchOutSelect').value, 10);
  const inIdx = parseInt(document.getElementById('inmatchInSelect').value, 10);
  if (isNaN(outIdx) || isNaN(inIdx) || !team.bench || !team.bench[inIdx]) return;
  const outPlayer = team.players[outIdx];
  const inPlayer = team.bench.splice(inIdx, 1)[0];
  inPlayer.x = outPlayer.x;
  inPlayer.y = outPlayer.y;
  inPlayer.pos = outPlayer.pos;
  inPlayer.naturalPos = inPlayer.naturalPos || inPlayer.pos;
  inPlayer.minutesPlayed = 90 - matchMinute;
  inPlayer.condition = Math.min(100, inPlayer.condition + 5);
  outPlayer.minutesPlayed = matchMinute;
  team.players[outIdx] = inPlayer;
  team.subsUsed++;
  addLog(matchMinute + '\\' Değişiklik: ' + outPlayer.name + ' çıktı, ' + inPlayer.name + ' girdi!', "tactics-log");
  populateInmatchSelects();
});
"""

# En son </script> etiketinden önce ekle
content = content.replace('updateStatsDisplay();\nrender();\n</script>', 'updateStatsDisplay();\nrender();' + extra_js + '\n</script>')

# Yeni dosyaya kaydet
with open('elite_manager_v2.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("✅ elite_manager_v2.html oluşturuldu!")
print("🚀 Şimdi şu komutla çalıştır:")
print("   python -m http.server 8081 &")
print("   termux-open-url http://localhost:8081/elite_manager_v2.html")

