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
git clone https://github.com/Civops-Platform/open-signals && cd open-signals   # Node 20+, no npm install needed
alias open-signals='node bin/open-signals.mjs'
open-signals sources fires                     # search the catalogue
open-signals sources --topic water --fetchable
open-signals fetch usgs-earthquakes --min 4.5 --window week
open-signals fetch noaa-coops --coops 8518750   # any CO-OPS station
open-signals fetch open-meteo --lat 41.5 --lng -81.7
open-signals layer water_level                 # GeoJSON
open-signals serve --port 3290                 # REST + MCP
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

### CESMII i3X

The same layers are served as a read-only [CESMII i3X 1.0](https://github.com/cesmii/i3X) endpoint at
`https://open-signals.civops.io/i3x/v1`. The address space has a root, one folder per layer, and one
object per place or event. Each object's value is its latest reading (value, quality, timestamp) with
source and licence, and its history is every reading held for that place. Subscriptions support sync
and server-sent-event streams.

CESMII's conformance suite (build 6, run 10 October 2026) rates it **i3X 1.0 Compatible**: 50 passed,
0 failed, 10 skipped ([report](docs/i3x-conformance-2026-10-10.json)). The skipped tests are the write tests; full compliance needs writes, and a server
that republishes public data has nothing to write.

The spec requires authentication on data endpoints, so there is a free public read-only token:
`os-public-read` (send `Authorization: Bearer os-public-read`). `GET /i3x/v1/info` needs none.

### Static datasets

Data that changes slowly is served as GeoJSON files rather than fetched live: wildfire burn
perimeters for the last 20 years (NIFC WFIGS and USFS MTBS, one file per state), public-land share
by county (USGS PAD-US 4.1), federal campgrounds (RIDB) and fire-weather stations (RAWS), all public
domain. `GET /v1/datasets` lists them with source, licence and parts; `GET /v1/datasets/{id}/{part}`
returns one part (a two-letter state, or `all`). A deployment points `OPEN_SIGNALS_DATA_DIR` at a
folder holding the files and an `index.json`; the format is described in `src/datasets.js`.

### MCP

`POST /mcp` uses the streamable HTTP transport (JSON-RPC 2.0). It is stateless and needs no auth.
Every tool is read-only:

- `search_sources`, `get_source`, `list_hubs`, `list_places`
- `get_readings`, `list_layers`, `get_layer`
- `list_datasets`, `get_dataset_part`

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
| `openfda-recalls` | FDA food, drug and device recalls of the last 60 days, at the firm's ZIP | — |
| `usaspending` | the 100 largest new federal contract awards of the last 30 days, at the place-of-performance ZIP | — |
| `gbif` | open-licensed (CC0, CC-BY) wildlife and plant observations of the last two weeks, worldwide, by group and box | — |
| `nasa-eonet` | open natural events worldwide (storms, wildfires, volcanoes, floods, ice), latest position | — |
| `world-bank` | World Bank indicators by country at the capital: GDP growth, inflation, manufacturing, exports, FDI, unemployment | — |
| `emsc` | EMSC-CSEM earthquakes worldwide, densest over Europe (CC BY 4.0), by window and magnitude floor | — |
| `noaa-ibtracs` | the latest best-track fix of every active tropical cyclone, any basin | — |
| `eurostat` | industrial production by country (index or year-on-year), latest month, at the capital | — |
| `gem-trackers` | Global Energy Monitor Global Integrated Power Tracker (CC BY 4.0, 2026-08 release): plants of 50 MW and up, operating or under construction, by country, fuel and status (replaces the WRI database, static since 2021) | — |
| `openfema` | FEMA disaster declarations of the last 90 days, at the county (or state) point | — |
| `usda-ams-barge` | weekly downbound grain tonnage at seven Mississippi, Illinois, Ohio and Arkansas River locks (USDA AMS, from USACE LPMS) | — |
| `bts-border-crossings` | inbound trucks, trains and vehicles per US-Canada and US-Mexico port of entry, latest month | — |
| `epa-tri` | Toxics Release Inventory: on-site releases per facility in a state, latest reporting year | — |
| `epa-campd` | power-plant CO2, SO2 and NOx per facility in a state, latest month in EPA's keyless bulk files | — |
| `noaa-coops` | water levels at any CO-OPS station (LWD on the Great Lakes, MLLW on tidal stations) | — |
| `usgs-water` | river discharge and gage height at any USGS gauge | — |
| `glerl` | Great Lakes ice cover (December to May) | — |
| `usda-nass` | weekly crop progress and condition, national and by state | `NASS_API_KEY` (free) |
| `open-meteo` | daily weather, 92 days back and 7 forward, anywhere | — (non-commercial) |
| `waterfowl-wsi` | the duck Weather Severity Index (Schummer et al. 2010) from Open-Meteo | — (non-commercial) |
| `ebird` | waterfowl reported in an eBird region in the last 7 days | `EBIRD_API_KEY` (free, non-commercial) |
| `open-meteo-flood` | GloFAS river discharge today at about a hundred large-river locations worldwide, with the week's change and the 30-day ensemble high | — (non-commercial) |
| `open-meteo-air` | CAMS modelled air quality now at 150 large cities: US AQI, European AQI, PM2.5, PM10 | — (non-commercial) |
| `adsb-lol` | live aircraft from the adsb.lol receiver network (ODbL): around any point (`mode=area`), every military-flagged aircraft worldwide (`mode=military`), or GPS interference per 1° cell inferred from aircraft position accuracy (`mode=gps`, the GPSJam method). Aircraft in the FAA LADD and PIA privacy programmes are never served | — |
| `smithsonian-gvp` | Smithsonian Volcanoes of the World: volcanoes erupting since 1900 worldwide, and those erupting now | — (non-commercial) |

### Observed, modelled or derived

A sensor reading and a conclusion drawn from it are not the same thing, so a reading says which it is.
No `basis` means something observed it (a gauge, a seismometer, a receiver). `basis: "modelled"` is a
model's output (Open-Meteo weather, GloFAS discharge, CAMS air quality). `basis: "derived"` is inferred
from other readings and carries `derived_from` saying from what (GPS interference from aircraft NACp, the
duck Weather Severity Index from modelled weather). Layer features always carry `basis`.

The rest of the catalogue is listed but not fetched yet. Adding a fetcher is the most useful
contribution; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Hubs

`catalog/hubs.json` lists the projects we watch so we don't search from scratch each time:

- [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (Bilawal Sidhu and Sameh Khamis)
- [World Monitor](https://github.com/koala73/worldmonitor)
- OSIRIS and WorldWideView
- Shadowbroker, ULTOR and Gemini / Claude Earth (community builds on the God's Eye View recipe)
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
