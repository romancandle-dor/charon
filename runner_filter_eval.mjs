import Database from 'better-sqlite3';
const db = new Database('charon.sqlite', { readonly: true });
const RUNNER_X = 2.0, EMAX = 90000, EMIN = 3000;

const perMint = new Map();
for (const row of db.prepare("SELECT mint, at_ms, payload_json FROM signal_events WHERE kind='trending' ORDER BY at_ms ASC").iterate()) {
  let p; try { p = JSON.parse(row.payload_json); } catch { continue; }
  const mc = Number(p.market_cap||0), peak = Number(p.history_highest_market_cap||0), mint = row.mint||p.address;
  if (!mint) continue;
  let e = perMint.get(mint);
  if (!e) {
    e = { firstMcap: mc, peak: Math.max(mc,peak), sd:Number(p.smart_degen_count||0), snp:Number(p.sniper_count||0),
          ren:Number(p.renowned_count||0), hold:Number(p.holder_count||0), cto:Number(p.cto_flag||0),
          rug:Number(p.rug_ratio||0), bund:Number(p.bundler_rate||0) };
    perMint.set(mint, e);
  } else { if (mc>e.peak) e.peak=mc; if (peak>e.peak) e.peak=peak; }
}
const pop = [];
for (const [,e] of perMint) {
  if (e.firstMcap<EMIN||e.firstMcap>EMAX||e.peak<=0) continue;
  pop.push({ ...e, runner: (e.peak/e.firstMcap)>=RUNNER_X });
}
const totalRunners = pop.filter(x=>x.runner).length;
const base = 100*totalRunners/pop.length;
console.log('zone tokens:', pop.length, '| runners:', totalRunners, '| base rate:', base.toFixed(1)+'%\n');

function evalFilter(name, fn) {
  const pass = pop.filter(fn);
  const passRun = pass.filter(x=>x.runner).length;
  const prec = pass.length? 100*passRun/pass.length : 0;
  const recall = 100*passRun/totalRunners;
  const lift = prec/base;
  console.log(name.padEnd(42), 'n='+String(pass.length).padStart(4),
    'prec='+prec.toFixed(0)+'%', 'recall='+recall.toFixed(0)+'%', 'lift='+lift.toFixed(1)+'x');
}

console.log('FILTER (at first sighting) | passes | precision(=>runner) | recall(of runners) | lift-vs-base');
console.log('--- single gates ---');
evalFilter('smart_degen_count >= 1', x=>x.sd>=1);
evalFilter('smart_degen_count >= 3', x=>x.sd>=3);
evalFilter('smart_degen_count >= 5', x=>x.sd>=5);
evalFilter('sniper_count >= 1', x=>x.snp>=1);
evalFilter('sniper_count >= 3', x=>x.snp>=3);
evalFilter('renowned_count >= 1', x=>x.ren>=1);
evalFilter('renowned_count >= 2', x=>x.ren>=2);
evalFilter('holder_count >= 100', x=>x.hold>=100);
evalFilter('cto_flag >= 1', x=>x.cto>=1);
console.log('--- OR combos (catch more) ---');
evalFilter('sd>=1 OR snp>=1 OR ren>=1', x=>x.sd>=1||x.snp>=1||x.ren>=1);
evalFilter('sd>=1 OR snp>=1', x=>x.sd>=1||x.snp>=1);
evalFilter('sd>=3 OR snp>=3 OR ren>=2', x=>x.sd>=3||x.snp>=3||x.ren>=2);
console.log('--- AND combos (purer) ---');
evalFilter('(sd>=1 OR snp>=1) AND hold>=50', x=>(x.sd>=1||x.snp>=1)&&x.hold>=50);
evalFilter('(sd>=3 OR snp>=3) AND rug<0.1', x=>(x.sd>=3||x.snp>=3)&&x.rug<0.1);
evalFilter('smart-any AND bund<0.4 AND rug<0.1', x=>(x.sd>=1||x.snp>=1||x.ren>=1)&&x.bund<0.4&&x.rug<0.1);
console.log('--- current sniper (no smart-money gate) ---');
evalFilter('ALL in zone (min_source only)', x=>true);
db.close();
