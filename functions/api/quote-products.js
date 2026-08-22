import pricingConfig from '../../data/cennik.json' with { type: 'json' };

const MAX_ITEMS = 10;
const MAX_BYTES = 1_500_000;
const MAX_REQUEST_BYTES = 32_000;
const MAX_REQUESTS_PER_MINUTE = 15;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
export const TOKEN_LIFETIME_MS = 20 * 60 * 1_000;
const NOTIFICATION_DEDUPE_WINDOW_MS = 5 * 60 * 1_000;
const QUOTE_RULES = Object.freeze({
  minimumJob: pricingConfig.publicRates.minimumJob,
  installationRate: pricingConfig.calculator.installationRate,
  travelPerKm: pricingConfig.publicRates.travel.outsideGliwicePerKilometer,
  roundTripMultiplier: pricingConfig.publicRates.travel.roundTripMultiplier
});
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
  'allegro.pl', 'www.allegro.pl',
  'kitchen.planner.ikea.com'
]);

const IKEA_PLANNER_HOSTS = ['kitchen.planner.ikea.com'];
const ALLEGRO_HOSTS = new Set(['allegro.pl', 'www.allegro.pl']);
const FETCH_HEADERS = Object.freeze({
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.5',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const API_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
});

function jsonResponse(body, init = {}) {
  const headers = new Headers(API_SECURITY_HEADERS);
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  return Response.json(body, { ...init, headers });
}

async function readLimitedRequest(request) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new Error('request-too-large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('request-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return decoder.decode(bytes);
}

function acceptsJson(request) {
  return String(request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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
    if (url.protocol !== 'https:' || url.username || url.password || isPrivateHost(url.hostname) || url.port && url.port !== '443') return null;
    if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

function allegroOfferId(url) {
  if (!ALLEGRO_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (/^\/produkt\/[a-z0-9-]+-[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(url.pathname)) {
    const values = url.searchParams.getAll('offerId');
    return values.length === 1 && /^\d{8,20}$/.test(values[0]) ? values[0] : null;
  }
  const offerPath = url.pathname.match(/^\/oferta\/[a-z0-9-]*?(\d{8,20})\/?$/i);
  if (!offerPath) return null;
  const queryId = url.searchParams.get('offerId');
  return queryId && queryId !== offerPath[1] ? null : offerPath[1];
}

function parsePrice(value) {
  const normalized = String(value ?? '')
    .replace(/&nbsp;|&#160;|\u00a0/gi, ' ')
    .trim()
    .replace(/[\s\u00a0]/g, '');
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(normalized)) return null;
  const price = Number(normalized.replace(',', '.'));
  return Number.isFinite(price) && price > 0 && price <= 1_000_000 ? price : null;
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function tagAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[3]);
  }
  return attributes;
}

function metaValues(html) {
  const values = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = tagAttributes(match[0]);
    const key = String(attributes.property || attributes.name || attributes.itemprop || '').toLowerCase();
    if (key && attributes.content != null && !values.has(key)) values.set(key, attributes.content);
  }
  return values;
}

function offerIdentifierMatches(value, offerId) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (text === offerId) return true;
  try {
    const url = new URL(text, 'https://allegro.pl');
    return url.searchParams.get('offerId') === offerId || new RegExp(`(?:^|-)${offerId}/?$`).test(url.pathname);
  } catch {
    return false;
  }
}

function jsonLdMatchesOffer(item, offer, offerId) {
  if (!offerId) return true;
  return [offer?.sku, offer?.offerId, offer?.productID, offer?.['@id'], offer?.url, item?.sku, item?.offerId, item?.productID]
    .some(value => offerIdentifierMatches(value, offerId));
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

function productFromJsonLd(html, offerId = null) {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    try {
      const root = JSON.parse(match[1].trim());
      for (const item of flatten(root)) {
        const type = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        if (!type.some(entry => String(entry).toLowerCase() === 'product')) continue;
        const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
        for (const offer of offers) {
          if (!offer || typeof offer !== 'object' || !jsonLdMatchesOffer(item, offer, offerId)) continue;
          const price = parsePrice(offer.price ?? offer.priceSpecification?.price);
          const currency = String(offer.priceCurrency || offer.priceSpecification?.priceCurrency || '').toUpperCase();
          if (price == null || currency !== 'PLN') continue;
          const name = cleanText(decodeHtml(item.name), 240);
          if (!name) continue;
          return { name, price, currency };
        }
      }
    } catch { /* Pomijamy niepoprawny blok JSON-LD. */ }
  }
  return null;
}

function productFromMeta(html, offerId = null) {
  const meta = metaValues(html);
  const price = parsePrice(meta.get('product:price:amount') ?? meta.get('price'));
  const currency = String(meta.get('product:price:currency') ?? meta.get('pricecurrency') ?? '').toUpperCase();
  const title = meta.get('og:title') ?? meta.get('twitter:title');
  if (price == null || currency !== 'PLN' || !title) return null;
  if (offerId && ![
    meta.get('product:retailer_item_id'), meta.get('product:sku'), meta.get('allegro:offer:id'), meta.get('og:url')
  ].some(value => offerIdentifierMatches(value, offerId))) return null;
  return { name: cleanText(decodeHtml(title).replace(/\s+/g, ' '), 240), price, currency: 'PLN' };
}

function visibleText(html) {
  return decodeHtml(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function allegroProductFromHtml(html, offerId) {
  if (!offerId) return null;
  const text = visibleText(html);
  const escapedOfferId = offerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`\\bNumer oferty:\\s*${escapedOfferId}\\b`, 'i').test(text)) return null;
  const sectionMatch = text.match(/\bWarunki oferty\b([\s\S]{0,4000}?)\bOpcje zakupu\b/i);
  if (!sectionMatch) return null;
  const prices = [...sectionMatch[1].matchAll(/\bcena\s+([0-9][0-9\s\u00a0]*(?:[.,][0-9]{1,2})?)\s*zł(?=\s|<|$)/gi)]
    .map(match => parsePrice(match[1]))
    .filter(price => price != null);
  const uniquePrices = [...new Set(prices)];
  if (uniquePrices.length !== 1) return null;
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = heading ? visibleText(heading) : metaValues(html).get('og:title');
  const name = cleanText(decodeHtml(title).replace(/\s+/g, ' '), 240);
  if (!name) return null;
  return { name, price: uniquePrices[0], currency: 'PLN' };
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

async function fetchProductHtml(startUrl, signal) {
  let url = startUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetch(url, { signal, redirect: 'manual', headers: FETCH_HEADERS });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount === MAX_REDIRECTS) throw new Error('too-many-redirects');
      const location = response.headers.get('location');
      const nextUrl = location ? validUrl(new URL(location, url).toString()) : null;
      if (!nextUrl) throw new Error('unsafe-redirect');
      url = nextUrl;
      continue;
    }
    if (!response.ok || response.type === 'opaqueredirect') throw new Error('unavailable');
    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!['text/html', 'application/xhtml+xml'].includes(contentType)) throw new Error('unsupported-content-type');
    return { html: await readLimited(response), finalUrl: url };
  }
  throw new Error('too-many-redirects');
}

async function resolveProduct(rawUrl) {
  const url = validUrl(rawUrl);
  if (!url) return { url: cleanText(rawUrl, 2048), error: 'Nieprawidłowy lub zablokowany adres URL.' };
  const isAllegro = ALLEGRO_HOSTS.has(url.hostname.toLowerCase());
  const offerId = isAllegro ? allegroOfferId(url) : null;
  if (isAllegro && !offerId) return { url: url.toString(), store: 'Allegro', error: 'Nieprawidłowy link do oferty Allegro.' };
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
    const { html } = await fetchProductHtml(url, controller.signal);
    const product = productFromJsonLd(html, offerId) || productFromMeta(html, offerId) || (isAllegro ? allegroProductFromHtml(html, offerId) : null);
    if (!product) return { url: url.toString(), error: 'Nie udało się automatycznie potwierdzić ceny tego produktu.' };
    return { url: url.toString(), ...(isAllegro ? { store: 'Allegro', offerId } : {}), ...product };
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

async function withinRequestRateLimit(env, request) {
  if (!env?.QUOTE_NOTIFICATION_KV) return true;
  try {
    const minute = Math.floor(Date.now() / 60_000);
    const client = await sha256(request.headers.get('cf-connecting-ip') || 'unknown');
    const key = `quote-products-rate:${client}:${minute}`;
    const count = Number(await env.QUOTE_NOTIFICATION_KV.get(key) || 0);
    if (!Number.isFinite(count) || count >= MAX_REQUESTS_PER_MINUTE) return false;
    await env.QUOTE_NOTIFICATION_KV.put(key, String(count + 1), { expirationTtl: 120 });
    return true;
  } catch {
    // Limiter KV jest ochroną best-effort i nie może wyłączyć kalkulatora przy awarii magazynu.
    return true;
  }
}

async function notificationKey(clientFingerprint, normalizedRequest, issuedAt) {
  const window = Math.floor(issuedAt / NOTIFICATION_DEDUPE_WINDOW_MS);
  return sha256(`${clientFingerprint}|${window}|${JSON.stringify(normalizedRequest)}`);
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
    || !['automatic_quote', 'price_not_confirmed'].includes(payload.eventType || (payload.quote ? 'automatic_quote' : ''))
    || ((payload.eventType || 'automatic_quote') === 'automatic_quote' && !payload.quote)
    || (payload.eventType === 'price_not_confirmed' && (!payload.attempt || payload.reason !== 'price_not_confirmed'))
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
  const seenUrls = new Set();
  const items = rawItems.map(item => {
    const url = cleanText(item?.url, 2048);
    const quantity = Number(item?.quantity);
    if (!url || seenUrls.has(url) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('items');
    seenUrls.add(url);
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
    if (!acceptsJson(request)) return jsonResponse({ error: 'Wymagany jest format JSON.' }, { status: 415 });
    if (!await withinRequestRateLimit(env, request)) {
      return jsonResponse({ error: 'Zbyt wiele żądań. Spróbuj ponownie za chwilę.' }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    let rawBody;
    try {
      rawBody = await readLimitedRequest(request);
    } catch (error) {
      if (error?.message === 'request-too-large') return jsonResponse({ error: 'Żądanie jest zbyt duże.' }, { status: 413 });
      throw error;
    }
    const { items, extraServices, context } = normalizeRequest(JSON.parse(rawBody));
    const resolved = await Promise.all(items.map(item => resolveProduct(item.url)));
    const products = resolved.map((product, index) => ({
      ...product,
      quantity: items[index].quantity,
      ...(product.price ? { value: roundMoney(product.price * items[index].quantity) } : {})
    }));
    const allConfirmed = products.every(product => !product.error && Number.isFinite(product.price));
    const issuedAt = Date.now();
    const clientFingerprint = await sha256(`${request.headers.get('cf-connecting-ip') || 'unknown'}|${request.headers.get('user-agent') || 'unknown'}`);
    const quoteId = crypto.randomUUID();
    const dedupeKey = await notificationKey(clientFingerprint, { items, extraServices, context }, issuedAt);
    if (!allConfirmed) {
      let notificationToken = null;
      if (notificationSecret(env)) {
        const attempt = {
          products: products.map(product => ({
            url: product.url,
            quantity: product.quantity,
            ...(product.name ? { name: product.name } : {}),
            status: product.error ? 'price_not_confirmed' : 'confirmed_without_quote'
          })),
          extraServices
        };
        notificationToken = await signQuote({
          v: 1, eventType: 'price_not_confirmed', reason: 'price_not_confirmed', quoteId,
          notificationKey: dedupeKey, clientFingerprint, issuedAt, expiresAt: issuedAt + TOKEN_LIFETIME_MS,
          attempt, context
        }, env);
      }
      return jsonResponse({ products, allConfirmed: false, notificationToken, quoteId });
    }

    const furniture = roundMoney(products.reduce((sum, product) => sum + product.value, 0));
    const installation = Math.max(QUOTE_RULES.minimumJob, roundMoney(furniture * QUOTE_RULES.installationRate));
    const extraServicesTotal = extraServices.reduce((sum, service) => sum + service.value, 0);
    const travel = roundMoney(context.distance * QUOTE_RULES.roundTripMultiplier * QUOTE_RULES.travelPerKm);
    const quote = {
      products,
      furniture,
      installation,
      extraServices,
      extraServicesTotal,
      distance: context.distance,
      travel,
      total: roundMoney(installation + extraServicesTotal + travel)
    };
    const clientQuote = {
      ...quote,
      extraServices: quote.extraServices.map(({ serviceId, name, quantity }) => ({ serviceId, name, quantity }))
    };
    // Każde poprawne obliczenie dostaje własny identyfikator. Nie wyprowadzamy go
    // z IP, User-Agent ani treści wyceny, więc klienci za wspólnym NAT nie kolidują.
    let notificationToken = null;
    if (notificationSecret(env)) {
      notificationToken = await signQuote({
        v: 1, eventType: 'automatic_quote', quoteId, notificationKey: dedupeKey, clientFingerprint,
        issuedAt, expiresAt: issuedAt + TOKEN_LIFETIME_MS, quote, context
      }, env);
    }
    return jsonResponse({ products, allConfirmed: true, quote: clientQuote, notificationToken, quoteId });
  } catch {
    return jsonResponse({ error: 'Nieprawidłowe żądanie.' }, { status: 400 });
  }
}
