const MAX_URLS = 10;
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;
const ALLOWED_HOSTS = new Set([
  'ikea.com', 'www.ikea.com', 'ikea.pl', 'www.ikea.pl',
  'agatameble.pl', 'www.agatameble.pl',
  'brw.pl', 'www.brw.pl',
  'jysk.pl', 'www.jysk.pl',
  'kitchen.planner.ikea.com'
]);

const IKEA_PLANNER_HOSTS = ['kitchen.planner.ikea.com'];

function isIkeaPlanner(url) {
  return IKEA_PLANNER_HOSTS.includes(url.hostname.toLowerCase()) && /^\/pl\/pl\/planner\/[0-9a-f-]{20,}(?:\/|$)/i.test(url.pathname);
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true;
  if (/^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.0\.0\./.test(host) || /^192\.168\./.test(host) || /^198\.18\./.test(host) || /^198\.51\.100\./.test(host) || /^203\.0\.113\./.test(host) || /^22[4-9]\.|^23[0-9]\.|^24[0-9]\.|^25[0-5]\./.test(host)) return true;
  const m = host.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (host.includes(':')) {
    if (host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateHost(mapped[1]);
  }
  return false;
}

function validUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || isPrivateHost(url.hostname) || url.port && !['80', '443'].includes(url.port)) return null;
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
    url.username = '';
    url.password = '';
    return url;
  } catch { return null; }
}

function flatten(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (typeof value === 'object') {
    const own = [value];
    if (value['@graph']) own.push(...flatten(value['@graph']));
    return own;
  }
  return [];
}

function productFromJsonLd(html) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    try {
      const root = JSON.parse(match[1].trim());
      for (const item of flatten(root)) {
        const type = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        if (!type.some(t => String(t).toLowerCase() === 'product')) continue;
        const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        const offer = offers && typeof offers === 'object' ? offers : null;
        const price = Number(String(offer?.price ?? '').replace(',', '.'));
        const currency = String(offer?.priceCurrency || '').toUpperCase();
        if (!Number.isFinite(price) || price <= 0 || price > 1_000_000 || !/^(PLN|EUR|USD|GBP)$/.test(currency)) continue;
        const name = String(item.name || '').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        return { name: name.slice(0, 240), price, currency, sourceUrl: offer?.url || null };
      }
    } catch { /* Pomijamy niepoprawny blok JSON-LD. */ }
  }
  return null;
}

function productFromMeta(html) {
  const price = html.match(/(?:itemprop=["']price["'][^>]*content|property=["']product:price:amount["'][^>]*content)=["']([^"']+)/i)?.[1];
  const currency = html.match(/(?:itemprop=["']priceCurrency["'][^>]*content|property=["']product:price:currency["'][^>]*content)=["']([^"']+)/i)?.[1];
  const title = html.match(/<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]+content=["']([^"']+)/i)?.[1];
  const parsed = Number(String(price || '').replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0 || !currency || !title) return null;
  return { name: title.replace(/\s+/g, ' ').trim().slice(0, 240), price: parsed, currency: currency.toUpperCase(), sourceUrl: null };
}

async function readLimited(response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_BYTES) throw new Error('response-too-large');
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) throw new Error('response-too-large');
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function resolveProduct(rawUrl) {
  const url = validUrl(rawUrl);
  if (!url) return { url: String(rawUrl || ''), error: 'Nieprawidłowy lub zablokowany adres URL.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'text/html,application/xhtml+xml' } });
    if (!response.ok || response.type === 'opaqueredirect' || response.status >= 300) throw new Error('unavailable');
    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!['text/html', 'application/xhtml+xml'].includes(contentType)) throw new Error('unsupported-content-type');
    const html = await readLimited(response);
    if (isIkeaPlanner(url)) {
      const projectId = url.pathname.split('/').filter(Boolean).at(-1) || null;
      return {
        url: url.toString(),
        kind: 'ikea-project',
        store: 'IKEA Kitchen Planner',
        project: { name: 'Projekt IKEA Kitchen Planner', projectId, itemCount: null, products: [], total: null },
        error: 'Projekt IKEA został rozpoznany, ale nie możemy automatycznie odczytać jego wartości. Ten projekt wymaga indywidualnej wyceny.'
      };
    }
    const product = productFromJsonLd(html) || productFromMeta(html);
    if (!product) return { url: url.toString(), error: 'Nie udało się automatycznie potwierdzić ceny tego produktu.' };
    return { url: url.toString(), ...product };
  } catch (error) {
    return { url: url.toString(), error: error.name === 'AbortError' ? 'Przekroczono czas oczekiwania.' : 'Strona produktu jest niedostępna lub cena jest niejednoznaczna.' };
  } finally { clearTimeout(timer); }
}

export async function onRequestPost({ request }) {
  try {
    const body = await request.json();
    const urls = Array.isArray(body?.urls) ? body.urls.map(String).filter(Boolean) : [];
    if (!urls.length || urls.length > MAX_URLS) return Response.json({ error: 'Podaj od 1 do 10 linków.' }, { status: 400 });
    const products = await Promise.all(urls.map(resolveProduct));
    return Response.json({ products, allConfirmed: products.every(item => !item.error) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Nieprawidłowe żądanie.' }, { status: 400 }); }
}
