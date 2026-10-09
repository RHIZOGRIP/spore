# brave — web search

`"$SPORE_BRAVE" <words>` searches the web and prints what it found: one result per block, its
title, its URL and its description. Run it with `exec`, its output going to the file you name
in `out`, and read that file:

```
exec  command: "$SPORE_BRAVE" sprague grundy subtraction game   out: data/search.txt
```

It exits 0 with what was found, nothing included when nothing was. It exits 1 when the search
did not happen — a refused key, a rate limit, an answer it could not read — and says why on
stderr. Five results a search; ask again with other words rather than for more of the same.

The address and the key stay with the runner: you are given the results and never the
credential. A cell is not given `$SPORE_BRAVE`; one whose precursor grants `sources: [brave]`
asks the source itself, `node "$SPORE_SOURCE" brave --q <words> --out -`, for Brave's own JSON.
