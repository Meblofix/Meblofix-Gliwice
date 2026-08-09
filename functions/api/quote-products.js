const MAX_ITEMS = 10;
const MAX_BYTES = 1_500_000;
const MAX_REQUEST_BYTES = 32_000;
const TIMEOUT_MS = 8_000;
export const TOKEN_LIFETIME_MS = 20 * 60 * 1_000;
const QUOTE_RULES = Object.freeze({ minimumJob: 150, installationRate: 0.2, travelPerKm: 1.5 });
// Jedna wspólna tabela dla wszystkich lokalizacji. Przeglądarka przesyła tylko
// serviceId i quantity; nazwy oraz kwoty zawsze pochodzą z kontrolowanego backendu.
const EXTRA_SERVICE_CATALOG = Object.freeze({
  sink_cutout: Object.freeze({ name: 'Wycięcie otworu pod zlew', unitPrice: 100 }),
  hob_cutout: Object.freeze({ name: 'Wycięcie otworu pod płytę', unitPrice: 100 }),
  sink_install: Object.freeze({ name: 'Montaż zlewu', unitPrice: 100 }),
  tap_install: Object.freeze({ name: 'Montaż baterii', unitPrice: 60 }),
  dishwasher_connect: Object.freeze({ name: 'Podłączenie zmywarki', unitPrice: 80 }),
  hood_install: Object.freeze({ name: 'Montaż okapu', unitPrice: 100 })
});
const ALLOWED_FURNITURE_TYPES = new Set([
  'Meble z paczek',
  'Kuchnia z gotowych elementów/paczek',
  'Zestaw mebli'
]);
const ALLOWED_HOSTS = new Set([
  'ikea.com', 'www.ikea.com', 'ikea.pl', 'www.ikea.pl',
  'agatameble.pl', 'www.agatameble.pl',
  'brw.pl', 'www.brw.pl',
  'jysk.pl', 'www.jysk.pl',
  'kitchen.planner.ikea.com'
]);

const IKEA_PLANNER_HOSTS = ['kitchen.planner.ikea.com'];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}

function isGliwice(city) {
  return city.toLocaleLowerCase('pl-PL') === 'gliwice';
}

function isIkeaPlanner(url) {
  return IKEA_PLANNER_HOSTS.includes(url.hostname.toLowerCase()) && /^\/pl\/pl\/planner\/[0-9a-f-]{20,}(?:\/|$)/i.test(url.pathname);
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true;
  if (/^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.0\.0\./.test(host) || /^192\.168\./.test(host) || /^198\.18\./.test(host) || /^198\.51\.100\./.test(host) || /^203\.0\.113\./.test(host) || /^22[4-9]\.|^23[0-9]\.|^24[0-9]\.|^25[0-5]\./.test(host)) return true;
  const private172 = host.match(/^172\.(\d{1,3})\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
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
    url.hash = '';
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
        if (!type.some(entry => String(entry).toLowerCase() === 'product')) continue;
        const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        const offer = offers && typeof offers === 'object' ? offers : null;
        const price = Number(String(offer?.price ?? '').replace(',', '.'));
        const currency = String(offer?.priceCurrency || '').toUpperCase();
        if (!Number.isFinite(price) || price <= 0 || price > 1_000_000 || currency !== 'PLN') continue;
        const name = cleanText(item.name, 240);
        if (!name) continue;
        return { name, price, currency };
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
  if (!Number.isFinite(parsed) || parsed <= 0 || String(currency || '').toUpperCase() !== 'PLN' || !title) return null;
  return { name: cleanText(title.replace(/\s+/g, ' '), 240), price: parsed, currency: 'PLN' };
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
  return decoder.decode(bytes);
}

async function resolveProduct(rawUrl) {
  const url = validUrl(rawUrl);
  if (!url) return { url: cleanText(rawUrl, 2048), error: 'Nieprawidłowy lub zablokowany adres URL.' };
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { Accept: 'text/html,application/xhtml+xml' } });
    if (!response.ok || response.type === 'opaqueredirect' || response.status >= 300) throw new Error('unavailable');
    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!['text/html', 'application/xhtml+xml'].includes(contentType)) throw new Error('unsupported-content-type');
    const html = await readLimited(response);
    const product = productFromJsonLd(html) || productFromMeta(html);
    if (!product) return { url: url.toString(), error: 'Nie udało się automatycznie potwierdzić ceny tego produktu.' };
    return { url: url.toString(), ...product };
  } catch (error) {
    return { url: url.toString(), error: error.name === 'AbortError' ? 'Przekroczono czas oczekiwania.' : 'Strona produktu jest niedostępna lub cena jest niejednoznaczna.' };
  } finally { clearTimeout(timer); }
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function notificationSecret(env) {
  const secret = String(env?.QUOTE_NOTIFICATION_SECRET || '');
  return secret.length >= 32 ? secret : null;
}

async function sha256(value) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function signQuote(payload, env) {
  const secret = notificationSecret(env);
  if (!secret) throw new Error('missing-notification-secret');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secret),
    encoder.encode(JSON.stringify(payload))
  ));
  const signedValue = `v2.${bytesToBase64Url(iv)}.${bytesToBase64Url(encrypted)}`;
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(signedValue)));
  return `${signedValue}.${bytesToBase64Url(signature)}`;
}

export async function verifyQuoteToken(token, env) {
  const secret = notificationSecret(env);
  const parts = String(token || '').split('.');
  if (!secret) throw new Error('invalid-token');
  let payload;
  if (parts.length === 4 && parts[0] === 'v2') {
    const signedValue = parts.slice(0, 3).join('.');
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), base64UrlToBytes(parts[3]), encoder.encode(signedValue));
    if (!valid) throw new Error('invalid-token');
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlToBytes(parts[1]) },
      await encryptionKey(secret),
      base64UrlToBytes(parts[2])
    );
    payload = JSON.parse(decoder.decode(decrypted));
  } else if (parts.length === 3 && parts[0] === 'v1') {
    // Krótka zgodność wsteczna dla tokenów wystawionych przed wdrożeniem v2.
    const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), base64UrlToBytes(parts[2]), encoder.encode(parts[1]));
    if (!valid) throw new Error('invalid-token');
    payload = JSON.parse(decoder.decode(base64UrlToBytes(parts[1])));
  } else {
    throw new Error('invalid-token');
  }
  if (
    payload?.v !== 1
    || typeof payload.quoteId !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(payload.quoteId)
    || !payload.quote
    || !payload.context
    || !Number.isFinite(payload.issuedAt)
    || !Number.isFinite(payload.expiresAt)
    || payload.expiresAt <= payload.issuedAt
    || Date.now() > payload.expiresAt
  ) throw new Error('expired-token');
  return payload;
}

function normalizeRequest(body) {
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  if (!rawItems.length || rawItems.length > MAX_ITEMS) throw new Error('items');
  const items = rawItems.map(item => {
    const url = cleanText(item?.url, 2048);
    const quantity = Number(item?.quantity);
    if (!url || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('items');
    return { url, quantity };
  });
  const city = cleanText(body?.city, 80);
  const furnitureType = cleanText(body?.furnitureType, 80);
  const distanceInput = Number(body?.distance);
  if (!city || !ALLOWED_FURNITURE_TYPES.has(furnitureType) || !Number.isFinite(distanceInput) || distanceInput < 0 || distanceInput > 500) throw new Error('context');
  const distance = isGliwice(city) ? 0 : distanceInput;
  if (!isGliwice(city) && distance <= 0) throw new Error('distance');
  const rawExtraServices = body?.extraServices == null ? [] : body.extraServices;
  if (!Array.isArray(rawExtraServices) || rawExtraServices.length > 10) throw new Error('extra-services');
  const seenServiceIds = new Set();
  const extraServices = rawExtraServices.map(item => {
    const serviceId = cleanText(item?.serviceId, 80);
    const quantity = Number(item?.quantity);
    const service = EXTRA_SERVICE_CATALOG[serviceId];
    if (!service || seenServiceIds.has(serviceId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw new Error('extra-services');
    }
    seenServiceIds.add(serviceId);
    const value = Math.round(service.unitPrice * quantity);
    return { serviceId, name: service.name, quantity, unitPrice: service.unitPrice, value };
  });
  return {
    items,
    extraServices,
    context: {
      city,
      distance,
      furnitureType,
      details: cleanText(body?.details, 2000),
      contact: {
        name: cleanText(body?.contact?.name, 80),
        phone: cleanText(body?.contact?.phone, 20),
        email: cleanText(body?.contact?.email, 254)
      }
    }
  };
}

export async function onRequestPost({ request, env }) {
  try {
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_REQUEST_BYTES) return Response.json({ error: 'Żądanie jest zbyt duże.' }, { status: 413 });
    const rawBody = await request.text();
    if (encoder.encode(rawBody).byteLength > MAX_REQUEST_BYTES) return Response.json({ error: 'Żądanie jest zbyt duże.' }, { status: 413 });
    const { items, extraServices, context } = normalizeRequest(JSON.parse(rawBody));
    const resolved = await Promise.all(items.map(item => resolveProduct(item.url)));
    const products = resolved.map((product, index) => ({
      ...product,
      quantity: items[index].quantity,
      ...(product.price ? { value: Math.round(product.price * items[index].quantity) } : {})
    }));
    const allConfirmed = products.every(product => !product.error && Number.isFinite(product.price));
    if (!allConfirmed) return Response.json({ products, allConfirmed: false }, { headers: { 'Cache-Control': 'no-store' } });

    const furniture = products.reduce((sum, product) => sum + product.value, 0);
    const installation = Math.max(QUOTE_RULES.minimumJob, Math.round(furniture * QUOTE_RULES.installationRate));
    const extraServicesTotal = extraServices.reduce((sum, service) => sum + service.value, 0);
    const travel = Math.round(context.distance * 2 * QUOTE_RULES.travelPerKm);
    const quote = {
      products,
      furniture,
      installation,
      extraServices,
      extraServicesTotal,
      distance: context.distance,
      travel,
      total: installation + extraServicesTotal + travel
    };
    const clientQuote = {
      ...quote,
      extraServices: quote.extraServices.map(({ serviceId, name, quantity }) => ({ serviceId, name, quantity }))
    };
    const issuedAt = Date.now();
    const clientFingerprint = await sha256(`${request.headers.get('cf-connecting-ip') || 'unknown'}|${request.headers.get('user-agent') || 'unknown'}`);
    // Każde poprawne obliczenie dostaje własny identyfikator. Nie wyprowadzamy go
    // z IP, User-Agent ani treści wyceny, więc klienci za wspólnym NAT nie kolidują.
    const quoteId = crypto.randomUUID();
    let notificationToken = null;
    if (notificationSecret(env)) {
      notificationToken = await signQuote({ v: 1, quoteId, clientFingerprint, issuedAt, expiresAt: issuedAt + TOKEN_LIFETIME_MS, quote, context }, env);
    }
    return Response.json({ products, allConfirmed: true, quote: clientQuote, notificationToken, quoteId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: 'Nieprawidłowe żądanie.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
}
