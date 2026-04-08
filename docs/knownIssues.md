# Known Issues

## Multi-artist search query dilution

**Affected track example:** Ghost Orchid — Nick León & Ela Minus

When `enrich.py` searches SoundCloud for individual tracks, it uses the full artist string as the query (e.g. `"Nick León & Ela Minus Ghost Orchid"`). For multi-artist names joined by `&`, `,`, `x`, etc., this dilutes the query and SoundCloud returns irrelevant results — even though the track exists and is found immediately with just `"Nick León Ghost Orchid"`.

The existing retry logic only strips parentheticals like `(feat. X)` but doesn't simplify multi-artist names.

**Potential fix:** Add a retry that splits on `&`/`,`/`x`/`feat` and searches with each individual artist + title.

## Crate index artwork can be stale

The crate index (`kv-crates-index.json`) bakes in artwork URLs from `audio_cache.json` at build time. If `enrich.py` finds new artwork after the crate index was built, the crate will show a gradient placeholder while the Shuffle view shows the actual artwork.

**To fix:** Rebuild the crate index after running enrichment:
```bash
cd pipeline && python3 enrich.py
node scripts/build_crates_index.js
npx wrangler kv:bulk put --namespace-id=04f5b3defaf84e6ba843159adc9d6 pipeline/output/kv-crates-index.json
```
