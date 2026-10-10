# open-signals — how to work in this repo

Public repository. Anything committed here is published.

- Never commit keys, `.env`, personal places, or data from Ryan's private services
  (Genome scores, Market Intelligence, subscriber lists). Upstream keys are read from the
  environment and named in the catalogue by variable name only.
- Licence is the field that matters most: a source is `unknown` until someone has read its
  terms. Never upgrade a licence on a guess.
- `npm test` must stay green; `npm run test:live` before any release.
- The fetchers were ported from the personal service `Civops-Platform/signals`. That service
  should import them from this package rather than keep its own copies; until it does, a fix
  made in one belongs in the other.
