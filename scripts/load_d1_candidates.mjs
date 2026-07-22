// Load web-app/output/candidates-d1.json into the b2b-candidates D1 database.
//
// Run build_kv.js first — it emits candidates-d1.json (+ the KV bulk files).
// This script computes the cumulative-weight column (cw) used by the shuffle
// fast path, loads everything into a NON-LIVE candidates_new table, and verifies
// it. Production keeps serving the old table until you cut over with --swap.
//
// Usage (wrap in `caffeinate -dims` for the long load):
//   node scripts/load_d1_candidates.mjs          # load candidates_new + verify (no swap)
//   node scripts/load_d1_candidates.mjs --swap    # atomic cutover -> candidates (keeps candidates_old)
//
// Recommended full rebuild sequence:
//   1) node scripts/build_kv.js
//   2) node scripts/load_d1_candidates.mjs                 # load + verify
//   3) upload KV bulk (npx wrangler kv bulk put ... kv-bulk-*.json)  ← nodes get new audio
//   4) node scripts/load_d1_candidates.mjs --swap           # cut over

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', 'pipeline', 'output');
const DB = 'b2b-candidates';
const SWAP = process.argv.includes('--swap');

// Run a SQL command or file against the remote D1. Returns parsed JSON when json=true.
function d1(arg, { file = false, json = false } = {}) {
  const a = file ? `--file "${arg}"` : `--command "${arg.replace(/"/g, '\\"')}"`;
  const out = execSync(`npx wrangler d1 execute ${DB} --remote ${json ? '--json' : ''} ${a} -y`, {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
  });
  return json ? JSON.parse(out) : out;
}
const firstRow = (res) => res?.[0]?.results?.[0] ?? {};

// ── --swap: atomic cutover (keeps one generation of rollback as candidates_old) ──
if (SWAP) {
  console.log('Cutting over: candidates_new -> candidates (keeping candidates_old)...');
  d1(`DROP TABLE IF EXISTS candidates_old;
      DROP TABLE IF EXISTS meta_old;
      ALTER TABLE candidates RENAME TO candidates_old;
      ALTER TABLE candidates_new RENAME TO candidates;
      ALTER TABLE meta RENAME TO meta_old;
      ALTER TABLE meta_new RENAME TO meta;`);
  const { n } = firstRow(d1('SELECT COUNT(*) AS n FROM candidates', { json: true }));
  console.log(`Swap complete. Live candidates: ${n}`);
  process.exit(0);
}

// ── Load phase ──
const cands = JSON.parse(readFileSync(`${root}/candidates-d1.json`, 'utf8'));
console.log(`${cands.length} candidates from candidates-d1.json`);

// Cumulative weight over array order — the shuffle fast path seeks on this.
let cw = 0;
for (const c of cands) { cw += Number(c.w ?? 1); c._cw = cw; }
const totalWeight = cw, totalCount = cands.length;

const OUT = `${root}/d1load`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const val = (c) => {
  const ss = c.ss == null ? 'NULL' : sq(c.ss);
  const g = sq(JSON.stringify(c.g || [])), d = sq(JSON.stringify(c.d || []));
  return `(${sq(c.id)},${Number(c.w ?? 1)},${sq(c.s)},${c.st ? 1 : 0},${ss},${sq(c.a)},${sq(c.t)},${Number(c.e || 0)},${g},${d},${c._cw})`;
};

writeFileSync(`${OUT}/00_schema.sql`,
  `DROP TABLE IF EXISTS candidates_new;
CREATE TABLE candidates_new (
  id TEXT PRIMARY KEY, w REAL NOT NULL, s TEXT NOT NULL, st INTEGER NOT NULL,
  ss TEXT, a TEXT NOT NULL, t TEXT NOT NULL, e INTEGER NOT NULL,
  g TEXT NOT NULL, d TEXT NOT NULL, cw REAL NOT NULL
);
`);

const ROWS_PER_INSERT = 200, ROWS_PER_FILE = 5000;
const COLS = 'INSERT INTO candidates_new (id,w,s,st,ss,a,t,e,g,d,cw) VALUES\n';
let nfiles = 0;
for (let f = 0; f < cands.length; f += ROWS_PER_FILE) {
  const chunk = cands.slice(f, f + ROWS_PER_FILE), parts = [];
  for (let i = 0; i < chunk.length; i += ROWS_PER_INSERT)
    parts.push(COLS + chunk.slice(i, i + ROWS_PER_INSERT).map(val).join(',\n') + ';');
  writeFileSync(`${OUT}/data-${String(nfiles).padStart(3, '0')}.sql`, parts.join('\n') + '\n');
  nfiles++;
}

// _new-suffixed index names so they never collide with the live table's indexes.
writeFileSync(`${OUT}/99_index_meta.sql`,
  `CREATE INDEX idx_new_a  ON candidates_new(a);
CREATE INDEX idx_new_s  ON candidates_new(s);
CREATE INDEX idx_new_st ON candidates_new(st);
CREATE INDEX idx_new_e  ON candidates_new(e);
CREATE INDEX idx_new_cw ON candidates_new(cw);
DROP TABLE IF EXISTS meta_new;
CREATE TABLE meta_new (k TEXT PRIMARY KEY, v REAL);
INSERT INTO meta_new (k,v) VALUES ('total_count',${totalCount}),('total_weight',${totalWeight});
`);

console.log(`Generated schema + ${nfiles} data files. Loading into D1 (${DB})...`);
d1(`${OUT}/00_schema.sql`, { file: true });
for (let i = 0; i < nfiles; i++) {
  d1(`${OUT}/data-${String(i).padStart(3, '0')}.sql`, { file: true });
  process.stdout.write(`\r  loaded ${i + 1}/${nfiles} data files`);
}
process.stdout.write('\n');
d1(`${OUT}/99_index_meta.sql`, { file: true });

const { n, cwn } = firstRow(d1(
  'SELECT (SELECT COUNT(*) FROM candidates_new) AS n, (SELECT COUNT(*) FROM candidates_new WHERE cw IS NOT NULL) AS cwn',
  { json: true }));
console.log(`candidates_new: ${n} rows, ${cwn} with cw (expected ${totalCount}).`);
if (Number(n) !== totalCount || Number(cwn) !== totalCount) {
  console.error('❌ COUNT MISMATCH — do NOT swap. Investigate.');
  process.exit(1);
}
console.log(`\n✅ candidates_new ready and verified.
Next: upload KV bulk (so new nodes have audio), then cut over:
   node scripts/load_d1_candidates.mjs --swap`);
