# open-signals

Public data, ready for maps and agents. Every reading says where it came from, when it was
fetched, and what licence it carries.

open-signals has three parts:

- **A catalogue** of public data sources (`catalog/sources.json`). Each entry gives the API,
  coverage, cadence, the key it needs and its licence. Weather, water, ice, hazards, flights,
  ships, satellites, energy, emissions, filings, trade and more. It's the list to check before
  writing yet another fetcher.
- **Fetchers** for the sources we read today. Each one turns an upstream answer into one shape,
  the *reading*:

  ```json
  { "id": "noaa-coops:9063085:2026-10-10", "at": "2026-10-10", "metric": "water_level",
    "value": 2.762, "unit": "ft above LWD",
    "summary": "Lake Erie at Toledo 2026-10-10: mean 2.76 ft above low water datum (…)",
    "place": { "id": "coops-toledo", "name": "Lake Erie at Toledo", "lat": 41.6936, "lng": -83.4723 },
    "fields": { "station": "9063085", "datum": "LWD", "readings": 155 },
    "source": { "id": "noaa-coops", "name": "NOAA CO-OPS water levels", "url": "https://tidesandcurrents.noaa.gov/…",
                "fetched_at": "2026-10-10T19:12:03Z", "license": "public_domain" } }
  ```

- **Ways in**: a CLI, a REST API with an OpenAPI description, an MCP server for agents, and
  GeoJSON map layers. There are no runtime dependencies; it needs Node 20 or later.

## Use it

A public instance runs at **https://open-signals.civops.io** (REST under `/v1`, MCP at `/mcp`). It
serves only public-domain and open sources, holds no upstream keys, and is rate-limited per IP.
Try `https://open-signals.civops.io/v1/layers/volcanoes?elevated=true`.

```bash
npx open-signals sources fires                     # search the catalogue
npx open-signals sources --topic water --fetchable
npx open-signals fetch usgs-earthquakes --min 4.5 --window week
npx open-signals fetch noaa-coops --coops 8518750   # any CO-OPS station
npx open-signals fetch open-meteo --lat 41.5 --lng -81.7
npx open-signals layer water_level                 # GeoJSON
npx open-signals serve --port 3290                 # REST + MCP
```

`fetch` and `layer` run on your machine with your own keys (`NASS_API_KEY`, `EBIRD_API_KEY`). The
CLI prints each source's licence so you know what you may do with what you fetched.

### REST

| | |
|---|---|
| `GET /v1/sources?query=&topic=&license=&fetchable=` | search the catalogue |
| `GET /v1/sources/{id}` | one entry |
| `GET /v1/hubs` | projects that collect sources (below) |
| `GET /v1/places?tag=` | named places as GeoJSON |
| `GET /v1/readings?source={id}&place=&tag=&lat=&lng=&coops=&usgs=&ebird=&state=&bbox=&metric=&since=&limit=` | readings |
| `GET /v1/layers` · `GET /v1/layers/{id}?date=` | map layers as GeoJSON |
| `GET /openapi.json` | the full description |

### MCP

`POST /mcp` uses the streamable HTTP transport (JSON-RPC 2.0). It is stateless and needs no auth.
Every tool is read-only:

- `search_sources`, `get_source`, `list_hubs`, `list_places`
- `get_readings`, `list_layers`, `get_layer`

To add it to a client:

```json
{ "mcpServers": { "open-signals": { "type": "http", "url": "https://open-signals.civops.io/mcp" } } }
```

## Licences: what a server will republish

The code is Apache-2.0. **The data is not ours to relicense.** Every source keeps its own terms,
and the licence travels on every reading. A running server republishes data, so it applies a gate:

| licence | examples | served |
|---|---|---|
| `public_domain` | NOAA, USGS, USDA, NASA FIRMS, SEC | always |
| `open` | CC BY, ODbL (OpenStreetMap, adsb.lol, ECMWF, GDELT) | always; attribution travels with it |
| `non_commercial` | Open-Meteo free tier, eBird, OpenSky | only with `OPEN_SIGNALS_NONCOMMERCIAL=1` (you run a non-commercial deployment) |
| `restricted` | Google 3D Tiles, TomTom | never |
| `unknown` | anything not yet reviewed | never |

A refused source answers `451` with the licence and the reason. Fetching for yourself with the CLI
is not republishing, so the gate doesn't apply there.

## Fetchers today

| source | what | key |
|---|---|---|
| `usgs-earthquakes` | worldwide earthquakes, by window and magnitude floor | — |
| `usgs-volcanoes` | alert level and aviation colour code for every monitored US volcano | — |
| `noaa-nwps` | river stage and flood category (observed and forecast) at every NOAA gauge in a box | — |
| `epa-echo` | major EPA-regulated facilities in a state, with compliance status and penalties | — |
| `noaa-coops` | water levels at any CO-OPS station (LWD on the Great Lakes, MLLW on tidal stations) | — |
| `usgs-water` | river discharge and gage height at any USGS gauge | — |
| `glerl` | Great Lakes ice cover (December to May) | — |
| `usda-nass` | weekly crop progress and condition, national and by state | `NASS_API_KEY` (free) |
| `open-meteo` | daily weather, 92 days back and 7 forward, anywhere | — (non-commercial) |
| `waterfowl-wsi` | the duck Weather Severity Index (Schummer et al. 2010) from Open-Meteo | — (non-commercial) |
| `ebird` | waterfowl reported in an eBird region in the last 7 days | `EBIRD_API_KEY` (free, non-commercial) |

The rest of the catalogue is listed but not fetched yet. Adding a fetcher is the most useful
contribution; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Hubs

`catalog/hubs.json` lists the projects we watch so we don't search from scratch each time:

- [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (Bilawal Sidhu and Sameh Khamis)
- [World Monitor](https://github.com/koala73/worldmonitor)
- OSIRIS and WorldWideView
- the official MCP Registry and awesome-mcp-servers
- Source Cooperative, the AWS Open Data registry, Data.gov and public-apis

When a source is found through one of them, its entry records that in `found_via`.

## Run it

```bash
npm test                  # offline, upstreams stubbed
npm run test:live         # every fetcher against its real upstream, then REST and MCP
PORT=3290 npm start
```

| variable | meaning |
|---|---|
| `PORT` | default 3290 |
| `OPEN_SIGNALS_NONCOMMERCIAL=1` | this deployment is non-commercial and may republish non-commercial sources |
| `RATE_LIMIT_PER_MIN` | per client IP, default 60 |
| `TRUST_PROXY=1` | read the client IP from `X-Forwarded-For` behind a proxy |

Responses are cached in memory per source, place and parameters (2 minutes for earthquakes,
up to 6 hours for weekly sources), so upstreams see polite traffic.

## No warranty

open-signals passes on what public agencies and projects publish, as they publish it. Readings can be
late, preliminary, revised or wrong upstream. It is provided as is (see LICENSE), and it is not for
navigation, safety or any decision that cannot tolerate a bad reading.
