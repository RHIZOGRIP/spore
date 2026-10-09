/**
 * What the brave source answered, as `$SPORE_BRAVE` prints it: one result per
 * block, title, URL and description. The call itself is the runner's — the key never reaches
 * the agent — so this reads the source broker's `{ status, ok, body }`.
 */
export const searchResults = ({ status, ok, body }) => {
  // A refusal is not an empty result. Without this a 429 or a bad key came back as a
  // search that worked and found nothing — exit 0, no error, and an agent with no reason
  // to doubt it.
  if (!ok) throw new Error(`${status}${body ? ` — ${body.slice(0, 200)}` : ''}`)

  let d
  try {
    d = JSON.parse(body)
  } catch {
    // An HTML error page from something in front of the API answers 200 as readily as
    // it answers 502, and `JSON.parse` alone reports a syntax error at a character
    // offset — true, and no help in working out what answered.
    throw new Error(`${status} response was not JSON — ${body.slice(0, 200)}`)
  }

  // `results: []` is a search that found nothing, which is an answer. A body carrying
  // no results array at all is a shape this does not understand, and handing back an
  // empty string for it is the same lie as handing one back for a 429.
  if (!Array.isArray(d.web?.results)) {
    throw new Error(`${status} response had no web.results — ${body.slice(0, 200)}`)
  }
  return d.web.results.map(x => `${x.title}\n${x.url}\n${x.description}`).join('\n\n')
}
