import Database from 'better-sqlite3';
const db = new Database('charon.sqlite', { readonly: true });

// Aggregate per mint from trending events: first-seen snapshot + peak mcap.
// Runner = peak / first-seen-mcap >= threshold. Learn which first-seen features predict it.
const RUNNER_X = 2.0;          // >=2x from first sighting = runner
const ENTRY_MAX_MCAP = 90000;  // only judge tokens we'd actually consider (buy-low zone)
const ENTRY_MIN_MCAP = 3000;

const perMint = new Map();
const stmt = db.prepare("SELECT mint, at_ms, payload_json FROM signal_events WHERE kind='trending' ORDER BY at_ms ASC");

let scanned = 0;
for (const row of stmt.iterate()) {
  scanned++;
  let p;
  try { p = JSON.parse(row.payload_json); } catch { continue; }
  const mc = Number(p.market_cap || 0);
  const peakField = Number(p.history_highest_market_cap || 0);
  const mint = row.mint || p.address;
  if (!mint) continue;
  let e = perMint.get(mint);
  if (!e) {
    // first sighting -> capture entry-time features
    e = {
      firstMcap: mc,
      firstAt: row.at_ms,
      peak: Math.max(mc, peakField),
      // features at first sighting (the moment we'd decide to buy)
      f: {
        smart_degen_count: Number(p.smart_degen_count || 0),
        sniper_count: Number(p.sniper_count || 0),
        renowned_count: Number(p.renowned_count || 0),
        bundler_rate: Number(p.bundler_rate || 0),
        rug_ratio: Number(p.rug_ratio || 0),
        holder_count: Number(p.holder_count || 0),
        top_10_holder_rate: Number(p.top_10_holder_rate || 0),
        bluechip_owner_percentage: Number(p.bluechip_owner_percentage || 0),
        volume: Number(p.volume || 0),
        swaps: Number(p.swaps || 0),
        liquidity: Number(p.liquidity || 0),
        hot_level: Number(p.hot_level || 0),
        bot_degen_count: Number(p.bot_degen_count || 0),
        rat_trader_amount_rate: Number(p.rat_trader_amount_rate || 0),
        is_honeypot: p.is_honeypot ? 1 : 0,
        renounced: (p.is_renounced || p.renounced_mint) ? 1 : 0,
        square_mentions: Number(p.square_mentions || 0),
        cto_flag: Number(p.cto_flag || 0),
        dev_team_hold_rate: Number(p.dev_team_hold_rate || 0),
        top70_sniper_hold_rate: Number(p.top70_sniper_hold_rate || 0),
      },
      launchpad: p.launchpad_platform || p.launchpad || '?',
    };
    perMint.set(mint, e);
  } else {
    if (mc > e.peak) e.peak = mc;
    if (peakField > e.peak) e.peak = peakField;
  }
}

// Filter to the buy-low decision zone, compute multiple + label
const pop = [];
for (const [mint, e] of perMint) {
  if (e.firstMcap < ENTRY_MIN_MCAP || e.firstMcap > ENTRY_MAX_MCAP) continue;
  if (e.peak <= 0 || e.firstMcap <= 0) continue;
  const mult = e.peak / e.firstMcap;
  pop.push({ mint, mult, runner: mult >= RUNNER_X, ...e });
}

const runners = pop.filter(x => x.runner);
const duds = pop.filter(x => !x.runner);

console.log('=== POPULATION (first-seen mcap in $' + ENTRY_MIN_MCAP + '-$' + ENTRY_MAX_MCAP + ' zone) ===');
console.log('scanned trending events:', scanned);
console.log('unique tokens in zone:', pop.length);
console.log('runners (>=' + RUNNER_X + 'x peak):', runners.length, '(' + (100*runners.length/pop.length).toFixed(1) + '%)');
console.log('duds:', duds.length);

// Feature comparison: median + "lift" (runner median / dud median)
const FEATURES = Object.keys(pop[0].f);
function median(arr) { if (!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function mean(arr){return arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;}
function pctNonZero(arr){return arr.length?100*arr.filter(v=>v>0).length/arr.length:0;}

console.log('\n=== FEATURE COMPARISON: runners vs duds (at first sighting) ===');
console.log('feature | runnerMed | dudMed | runnerMean | dudMean | %nz-run | %nz-dud | signal');
const ranked = [];
for (const f of FEATURES) {
  const rv = runners.map(x => x.f[f]);
  const dv = duds.map(x => x.f[f]);
  const rMed = median(rv), dMed = median(dv);
  const rMean = mean(rv), dMean = mean(dv);
  const rNz = pctNonZero(rv), dNz = pctNonZero(dv);
  // signal score: relative difference in means, guarded
  const lift = dMean !== 0 ? (rMean - dMean) / Math.abs(dMean) : (rMean !== 0 ? 99 : 0);
  ranked.push({ f, rMed, dMed, rMean, dMean, rNz, dNz, lift });
}
ranked.sort((a,b)=>Math.abs(b.lift)-Math.abs(a.lift));
for (const r of ranked) {
  console.log(
    r.f.padEnd(26),
    fmt(r.rMed), fmt(r.dMed), fmt(r.rMean), fmt(r.dMean),
    r.rNz.toFixed(0)+'%', r.dNz.toFixed(0)+'%',
    (r.lift>=0?'+':'')+(r.lift*100).toFixed(0)+'%'
  );
}
function fmt(n){ if(Math.abs(n)>=1000)return (n/1000).toFixed(1)+'k'; if(Number.isInteger(n))return String(n); return n.toFixed(2);}

// Top runners detail
console.log('\n=== TOP 15 RUNNERS (peak multiple) ===');
runners.sort((a,b)=>b.mult-a.mult).slice(0,15).forEach(r=>{
  console.log((r.mult.toFixed(0)+'x').padStart(6),
    '$'+(r.firstMcap/1000).toFixed(0)+'k->$'+(r.peak/1000000).toFixed(2)+'M',
    'sd='+r.f.smart_degen_count,'snp='+r.f.sniper_count,'ren='+r.f.renowned_count,
    'hold='+r.f.holder_count,'vol=$'+(r.f.volume/1000).toFixed(0)+'k',
    'bund='+(r.f.bundler_rate*100).toFixed(0)+'%','rug='+(r.f.rug_ratio*100).toFixed(0)+'%',
    r.launchpad);
});

db.close();
