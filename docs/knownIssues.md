# Known Issues

## Multi-artist search query dilution

**Affected track example:** Ghost Orchid — Nick León & Ela Minus

When `enrich.py` searches SoundCloud for individual tracks, it uses the full artist string as the query (e.g. `"Nick León & Ela Minus Ghost Orchid"`). For multi-artist names joined by `&`, `,`, `x`, etc., this dilutes the query and SoundCloud returns irrelevant results — even though the track exists and is found immediately with just `"Nick León Ghost Orchid"`.

The existing retry logic only strips parentheticals like `(feat. X)` but doesn't simplify multi-artist names.

**Potential fix:** Add a retry that splits on `&`/`,`/`x`/`feat` and searches with each individual artist + title.
