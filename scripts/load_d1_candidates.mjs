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

// Secondary indexes the LIVE `candidates` table must always carry. These are
// (re)built on the live table during --swap (see below), NOT during load —
// SQLite index names are global to the schema, so an index created on
// candidates_new survives the rename to `candidates` and then silently collides
// (via CREATE INDEX IF NOT EXISTS) with the next load, leaving the freshly-
// swapped table with no secondary indexes at all. Covering `(col, id)` lets the
// id be read straight from the index with no primary-key hop.
// NB: artist (`a`) is intentionally NOT indexed — the only query on it is
// `a LIKE '%...%'`, which a B-tree index can't serve; that path needs a
// normalized join table / FTS instead (separate follow-up).
const CAND_INDEXES = [
  ['idx_cand_cw', 'candidates(cw, id)'], // shuffle weighted-random seed seek
  ['idx_cand_e',  'candidates(e, id)'],  // crates minEdges + e>=4 pool
  ['idx_cand_s',  'candidates(s)'],      // source filter
  ['idx_cand_st', 'candidates(st)'],     // source-type filter
  ['idx_cand_t',  'candidates(t)'],      // exact-title filter
];

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

  // Build the secondary indexes on the now-live `candidates`. This MUST run
  // after the rename, not during load: the fresh candidates_new has no indexes,
  // so we create them here where the name is guaranteed free. DROP INDEX first
  // clears the name — after the rename above it's attached to candidates_old (or
  // a legacy idx_new_* on a dropped table) — then CREATE builds it on the live
  // table. This is the fix for indexes silently vanishing on every swap.
  console.log('Rebuilding indexes on live candidates...');
  d1(CAND_INDEXES
    .map(([name, def]) => `DROP INDEX IF EXISTS ${name};\nCREATE INDEX ${name} ON ${def};`)
    .join('\n'));

  // Verify every index is present on the LIVE table and fail loudly if not, so
  // a broken swap can never silently ship an unindexed (slow, expensive) table.
  const idxRows = d1(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='candidates'",
    { json: true })?.[0]?.results ?? [];
  const have = new Set(idxRows.map(r => r.name));
  const missing = CAND_INDEXES.map(([n]) => n).filter(n => !have.has(n));
  if (missing.length) {
    console.error(`❌ Missing indexes on live candidates after swap: ${missing.join(', ')}`);
    console.error('   The table is live but unindexed — rerun --swap or create them by hand.');
    process.exit(1);
  }

  const { n } = firstRow(d1('SELECT COUNT(*) AS n FROM candidates', { json: true }));
  console.log(`Swap complete. Live candidates: ${n}. Indexes verified: ${CAND_INDEXES.map(([n]) => n).join(', ')}`);
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

// Only meta is set up here. Secondary indexes are deliberately NOT created on
// candidates_new — they're built on the live table during --swap (see
// CAND_INDEXES) to avoid SQLite's global index-name collision. Building indexes
// pre-swap here is exactly what left every post-first generation unindexed.
writeFileSync(`${OUT}/99_meta.sql`,
  `DROP TABLE IF EXISTS meta_new;
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
d1(`${OUT}/99_meta.sql`, { file: true });

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
