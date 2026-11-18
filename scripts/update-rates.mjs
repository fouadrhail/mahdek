// Daily: fetch the Bank of Israel representative rates, the interest rate and the CPI, and save data/rates.json.
// Each source is independent: if one fails, its previous value is kept.
import fs from 'fs';
const FILE = new URL('../data/rates.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const BOI = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/';
const log = (...a) => console.log(...a);

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(c => c !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some(c => c !== '')) rows.push(row);
  const head = (rows.shift() || []).map(h => h.replace(/^﻿/, '').trim());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}
// newest observation per series: {seriesText, date, value}
export function latest(rows) {
  const out = {};
  for (const r of rows) {
    const date = r.TIME_PERIOD || r.time_period || '';
    const value = parseFloat(String(r.OBS_VALUE || r.obs_value || '').replace(',', '.'));
    if (!date || !isFinite(value)) continue;
    const key = r.SERIES_CODE || r.SERIES_KEY || Object.values(r).join('|');
    if (!out[key] || out[key].date < date) out[key] = { key, text: Object.values(r).join('|'), date, value };
  }
  return Object.values(out);
}
async function get(url, type = 'text') {
  const res = await fetch(url, { headers: { 'User-Agent': 'mahdek-rates (github.com/fouadrhail/mahdek)' } });
  if (!res.ok) throw new Error(res.status + ' ' + url);
  return type === 'json' ? res.json() : res.text();
}

async function fx() {
  const urls = [
    BOI + 'EXR/1.0/RER_USD_ILS,RER_EUR_ILS?format=csv&lastNObservations=1',
    BOI + 'EXR/1.0/?c%5BBASE_CURRENCY%5D=USD,EUR&c%5BCOUNTER_CURRENCY%5D=ILS&format=csv&lastNObservations=1'
  ];
  for (const u of urls) {
    try {
      const obs = latest(parseCsv(await get(u)));
      for (const cur of ['USD', 'EUR']) {
        const o = obs.filter(o => o.text.includes(cur) && (o.text.includes('RER_') || !obs.some(x => x.text.includes('RER_'))) && o.value > 0.5 && o.value < 20)
                     .sort((a, b) => b.date.localeCompare(a.date))[0];
        if (o) data.fx[cur] = { rate: +o.value.toFixed(3), date: o.date.slice(0, 10) };
      }
      if (data.fx.USD && data.fx.EUR) { log('fx ok', data.fx); return; }
    } catch (e) { log('fx failed:', e.message); }
  }
}

async function interest() {
  const urls = [
    BOI + 'BR/1.0/MNT_RIB_BOI_D?format=csv&lastNObservations=1',
    BOI + 'BR/1.0/?format=csv&lastNObservations=1'
  ];
  for (const u of urls) {
    try {
      const obs = latest(parseCsv(await get(u))).filter(o => o.value >= 0 && o.value < 20 && Math.abs(o.value * 4 - Math.round(o.value * 4)) < 1e-6);
      const o = obs.find(o => /RIB_BOI/.test(o.text)) || (obs.length === 1 ? obs[0] : null);
      if (o) {
        if (o.value !== data.boi.rate) { data.boi.rate = o.value; data.boi.since = o.date.slice(0, 10); }
        data.boi.auto = true; log('interest ok', data.boi); return;
      }
    } catch (e) { log('interest failed:', e.message); }
  }
  log('interest: kept', data.boi.rate);
}

// first object anywhere that has year, month and percent
function findObs(x) {
  if (!x || typeof x !== 'object') return null;
  if ('year' in x && 'month' in x && ('percent' in x || 'percentYear' in x)) return x;
  for (const v of Array.isArray(x) ? x : Object.values(x)) { const f = findObs(v); if (f) return f; }
  return null;
}
async function cpi() {
  try {
    const j = await get('https://api.cbs.gov.il/index/data/price?id=120010&format=json&download=false&last=1&lang=he', 'json');
    const o = findObs(j);
    if (o && isFinite(+o.percent)) {
      data.cpi = { month: `${o.year}-${String(o.month).padStart(2, '0')}`, change: +o.percent, yearly: isFinite(+o.percentYear) ? +o.percentYear : null };
      log('cpi ok', data.cpi);
    } else log('cpi: unexpected shape', JSON.stringify(j).slice(0, 300));
  } catch (e) { log('cpi failed:', e.message); }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  await Promise.all([fx(), interest(), cpi()]);
  data.updated = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
}
