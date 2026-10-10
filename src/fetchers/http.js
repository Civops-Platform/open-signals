export const UA = 'open-signals (+https://github.com/Civops-Platform/open-signals)';

/** GET JSON with a timeout. Non-2xx throws an Error carrying .status and .body. */
export async function getJson(fetchFn, url, init = {}, timeoutMs = 20000) {
  const res = await fetchFn(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status} from ${new URL(url).host}: ${text.slice(0, 200)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

/** YYYY-MM-DD for an instant in a time zone. */
export function localDate(d, timeZone = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
