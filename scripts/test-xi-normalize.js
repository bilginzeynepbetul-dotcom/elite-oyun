// Smoke: XI normalize kuralları (saveTeam / teamRoutes ile aynı mantık)
function normalizeXI(players, bench) {
  let starters = Array.isArray(players) ? players.filter(Boolean) : [];
  let b = Array.isArray(bench) ? bench.filter(Boolean) : [];
  if (starters.length > 11) {
    b = starters.slice(11).concat(b);
    starters = starters.slice(0, 11);
  }
  while (starters.length < 11 && b.length) {
    starters.push(b.shift());
  }
  return { starters, bench: b };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("OK:", msg);
  }
}

const a = normalizeXI(
  Array.from({ length: 15 }, (_, i) => ({ id: i + 1 })),
  [{ id: 100 }],
);
assert(a.starters.length === 11, "15 player → 11 starters");
assert(a.bench.length === 5, "extras go to bench (4+1)");

const b = normalizeXI(
  Array.from({ length: 7 }, (_, i) => ({ id: i + 1 })),
  Array.from({ length: 8 }, (_, i) => ({ id: 50 + i })),
);
assert(b.starters.length === 11, "7+bench → fill to 11");
assert(b.bench.length === 4, "remaining bench 4");

const c = normalizeXI([], []);
assert(c.starters.length === 0, "empty stays empty (save rejects)");

console.log(process.exitCode ? "SOME FAILED" : "ALL PASSED");
