# Contributing

There are three useful contributions, in order of value.

## 1. Add a source to the catalogue

Add one entry to `catalog/sources.json`. Every field matters:

- `id`: lowercase kebab-case, stable forever
- `name`, `homepage`, `api` (null if there's only a download)
- `topics`: reuse existing topics (`npx open-signals sources --json | jq '.[].topics[]' | sort -u`)
- `coverage`, `cadence`
- `auth`: null, or `{ "env": "VAR_NAME", "how": "where to get it" }`
- `license`: `public_domain` | `open` | `non_commercial` | `restricted` | `unknown`
- `license_note`: the terms in a sentence, with what they forbid
- `attribution`: if the terms ask for a credit line
- `fetcher`: null until one exists
- `found_via`: where you learned of it (a hub id, a project, a person)

**Licence is the field we review hardest.** Read the provider's terms. If you haven't read them,
the answer is `unknown`, which is honest and keeps the source unserved until someone has.
"It's a government site" is not a licence. State-level, municipal and non-US government data
often has terms of its own.

`npm test` validates the catalogue.

## 2. Write a fetcher

A fetcher is one file in `src/fetchers/` exporting:

```js
export const mySource = {
  source: 'my-source',          // the catalogue id
  metrics: ['what_it_measures'],
  places: 'how it picks places', // a sentence for humans
  params: { window: ['day', 'week'] },  // optional, closed sets only
  async fetch({ fetch, env, now, places, params, src }) {
    // return { status: 'ok' | 'off_season' | 'not_configured', readings: [...], detail? }
  },
};
```

Register it in `src/fetchers/index.js` and set `fetcher` on the catalogue entry.

The rules, each enforced somewhere in the tests:

- **Build readings with `reading()`** from `src/contract.js`. It requires provenance.
- **A missing key is `not_configured`**, returned without making a request. It is never an empty `ok`.
- **"Nothing this time of year" is `off_season`**, and only when the upstream says so. Any other
  failure throws.
- **A missing value is `null`, never `0`.** Withheld, blank and "(NA)" all become null or are skipped.
- **Ids are stable**: re-fetching the same observation gives the same id.
- **Params are closed sets.** Nothing a caller sends reaches a URL unchecked.
- **Be polite to upstreams**: call them sequentially, set a timeout, and back off on 429.
- Add a test in `tests/fetchers.test.mjs` with a canned upstream response, and a line in
  `scripts/live-check.mjs` passes on its own.

## 3. Add a layer

A layer is a fetcher's metric drawn on a map: one point per place for a date, or one point per
event. Add it to `LAYERS` in `src/service.js`, with a `read` line that tells a person how to
interpret the value and what it does not mean.

## What we won't merge

- Anything that finds, follows or identifies individual people.
- Data a provider's terms forbid us to republish, served anyway.
- Values invented to fill a gap. A gap is reported as a gap.
