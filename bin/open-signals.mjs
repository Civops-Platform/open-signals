#!/usr/bin/env node
/**
 * open-signals CLI
 *
 *   open-signals sources [words…] [--topic t] [--license l] [--fetchable]
 *   open-signals hubs
 *   open-signals places [--tag t]
 *   open-signals fetch <source> [--place a,b] [--tag t] [--lat n --lng n] [--coops id] [--usgs id] [--ebird code]
 *                               [--metric m] [--since iso] [--limit n] [--json]
 *   open-signals layer <id> [--date YYYY-MM-DD] [place options]
 *   open-signals serve [--port n]
 *
 * fetch and layer run on your machine with your keys (NASS_API_KEY,
 * EBIRD_API_KEY in the environment). They are not republishing, so every
 * source works; the licence is printed so you know what you may do with it.
 */

import { SOURCES, HUBS, PLACES, searchSources } from '../src/catalog.js';
import { createService } from '../src/service.js';
import { createServer } from '../src/server.js';

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
const words = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = rest[i + 1];
    if (next == null || next.startsWith('--')) args[k] = true;
    else { args[k] = next; i++; }
  } else words.push(a);
}

const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
const pad = (s, n) => String(s).padEnd(n);

try {
  switch (cmd) {
    case 'sources': {
      const list = searchSources({ query: words.join(' ') || undefined, topic: args.topic, license: args.license, fetchable: args.fetchable ? true : undefined });
      if (args.json) { out(list); break; }
      for (const s of list) console.log(`${pad(s.fetcher ? '●' : '○', 2)}${pad(s.id, 22)}${pad(s.license, 15)}${s.topics.join(',')}  — ${s.name}`);
      console.log(`\n${list.length} of ${SOURCES.length} sources (● has a fetcher)`);
      break;
    }
    case 'hubs':
      for (const h of HUBS) console.log(`${pad(h.id, 22)}${h.url}\n${' '.repeat(22)}${h.what}`);
      break;
    case 'places':
      for (const p of PLACES.filter((x) => !args.tag || x.tags?.includes(args.tag))) {
        console.log(`${pad(p.id, 26)}${pad(p.kind, 14)}${pad(`${p.lat},${p.lng}`, 22)}${[...(p.tags || []), ...Object.entries(p.refs || {}).map(([k, v]) => `${k}=${v}`)].join(' ')}`);
      }
      break;
    case 'fetch': {
      const id = words[0];
      if (!id) throw new Error('usage: open-signals fetch <source> [options]');
      const svc = createService();
      const s = SOURCES.find((x) => x.id === id);
      const r = await svc.readings(id, args, { mode: 'local' });
      if (args.json) { out(r); break; }
      console.error(`${s.name} — licence ${s.license}: ${s.license_note}`);
      console.error(`status ${r.status}${r.detail ? ` (${r.detail})` : ''}, ${r.count} readings\n`);
      for (const x of r.readings) console.log(`${pad(x.at.slice(0, 16), 18)}${pad(x.value ?? '—', 10)}${x.summary}`);
      break;
    }
    case 'layer': {
      const svc = createService();
      out(await svc.layer(words[0], args, { mode: 'local' }));
      break;
    }
    case 'serve': {
      const port = Number(args.port || process.env.PORT || 3290);
      createServer().listen(port, () => console.log(`[open-signals] listening on :${port}  (REST /v1, MCP /mcp)`));
      break;
    }
    default:
      console.log('open-signals sources | hubs | places | fetch <source> | layer <id> | serve   (see bin/open-signals.mjs header)');
      process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(`open-signals: ${e.message}`);
  process.exitCode = 1;
}
