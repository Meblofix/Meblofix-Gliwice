import { verifyQuoteToken } from './quote-products.js';

const RATE_LIMIT_PER_HOUR = 5;
const MAX_REQUEST_BYTES = 32_000;
const MAX_TOKEN_LENGTH = 24_000;
const MAX_REQUESTS_PER_MINUTE = 20;
const NOTIFICATION_RECORD_TTL_SECONDS = 30 * 60;
const memorySent = new Map();
const memoryRate = new Map();
const inFlight = new Map();
const decoder = new TextDecoder();
const encoder = new TextEncoder();

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

function acceptsJson(request) {
  return String(request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase() === 'application/json';
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

async function ingressFingerprint(request) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(request.headers.get('cf-connecting-ip') || 'unknown')
  ));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function withinIngressRateLimit(env, request) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `quote-notification-rate:${await ingressFingerprint(request)}:${minute}`;
  const count = Number(await env.QUOTE_NOTIFICATION_KV.get(key) || 0);
  if (!Number.isFinite(count) || count >= MAX_REQUESTS_PER_MINUTE) return false;
  await env.QUOTE_NOTIFICATION_KV.put(key, String(count + 1), { expirationTtl: 120 });
  return true;
}

function configuredFormspreeEndpoint(env) {
  const value = String(env?.QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT || '').trim();
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'formspree.io'
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
      || !/^\/f\/[a-z0-9]+$/i.test(url.pathname)
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function money(value) {
  const hasFraction = Math.round(Number(value) * 100) % 100 !== 0;
  return `${new Intl.NumberFormat('pl-PL', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2
  }).format(value)} zł`;
}

function polishDate(timestamp = Date.now()) {
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', dateStyle: 'long', timeStyle: 'medium'
  }).format(new Date(timestamp));
}

function mailField(value, maxLength = 20_000) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[<>]/g, '')
    .slice(0, maxLength);
}

function setMailField(fields, name, value, maxLength) {
  fields.set(name, mailField(value, maxLength));
}

function productLines(products) {
  return products.map((product, index) => [
    `${index + 1}. ${product.name}`,
    `Link: ${product.url}`,
    `Ilość: ${product.quantity}`,
    `Potwierdzona cena sztuki: ${money(product.price)}`,
    `Wartość pozycji: ${money(product.value)}`
  ].join('\n')).join('\n\n');
}

function extraServiceLines(services) {
  if (!Array.isArray(services) || services.length === 0) return 'Nie wybrano';
  return services.map((service, index) => [
    `${index + 1}. ${service.name}`,
    `Identyfikator: ${service.serviceId}`,
    `Ilość: ${service.quantity}`,
    `Cena jednostkowa: ${money(service.unitPrice)}`,
    `Wartość pozycji: ${money(service.value)}`
  ].join('\n')).join('\n\n');
}

function attemptProductLines(products) {
  return products.map((product, index) => [
    `${index + 1}. ${product.name || 'Produkt bez potwierdzonej nazwy'}`,
    `Link: ${product.url}`,
    `Ilość: ${product.quantity}`,
    'Status: cena niepotwierdzona'
  ].join('\n')).join('\n\n');
}

function attemptExtraServiceLines(services) {
  if (!Array.isArray(services) || services.length === 0) return 'Nie wybrano';
  return services.map((service, index) => [
    `${index + 1}. ${service.name}`,
    `Identyfikator: ${service.serviceId}`,
    `Ilość: ${service.quantity}`
  ].join('\n')).join('\n\n');
}

export function automaticNotificationFields(payload) {
  const { quote, context } = payload;
  const fields = new FormData();
  setMailField(fields, '_subject', 'Nowa wycena z kalkulatora Meblofix');
  setMailField(fields, 'typ_zdarzenia', 'AUTOMATYCZNA_WYCENA');
  setMailField(fields, 'data_i_godzina', polishDate(payload.issuedAt));
  setMailField(fields, 'identyfikator_wyceny', payload.quoteId);
  setMailField(fields, 'produkty', productLines(quote.products));
  setMailField(fields, 'laczna_wartosc_produktow', money(quote.furniture));
  setMailField(fields, 'koszt_montazu', money(quote.installation));
  setMailField(fields, 'uslugi_dodatkowe', extraServiceLines(quote.extraServices));
  setMailField(fields, 'laczny_koszt_uslug_dodatkowych', money(quote.extraServicesTotal || 0));
  setMailField(fields, 'koszt_dojazdu', money(quote.travel));
  setMailField(fields, 'laczna_orientacyjna_wycena', money(quote.total));
  setMailField(fields, 'miejscowosc', context.city, 80);
  setMailField(fields, 'odleglosc_od_gliwic_km', String(context.distance), 32);
  setMailField(fields, 'rodzaj_mebla', context.furnitureType, 80);
  setMailField(fields, 'dodatkowe_informacje', context.details || 'Nie podano', 2_000);
  setMailField(fields, 'imie', context.contact.name || 'Nie podano', 80);
  setMailField(fields, 'telefon', context.contact.phone || 'Nie podano', 20);
  setMailField(fields, 'email_klienta', context.contact.email || 'Nie podano', 254);
  setMailField(fields, 'dane_techniczne', 'Montaż: 20% wartości produktów, minimum techniczne 150 zł. Dojazd: odległość w jedną stronę × 2 × 1,50 zł. Kwoty obliczone i podpisane po stronie serwera.');
  return fields;
}


export function failedAttemptNotificationFields(payload) {
  const { attempt, context } = payload;
  const fields = new FormData();
  setMailField(fields, '_subject', 'Nieudana próba automatycznej wyceny');
  setMailField(fields, 'typ_zdarzenia', 'NIEUDANA_PROBA_AUTOMATYCZNEJ_WYCENY');
  setMailField(fields, 'data_i_godzina', polishDate(payload.issuedAt));
  setMailField(fields, 'identyfikator_proby', payload.quoteId);
  setMailField(fields, 'przyczyna', 'price_not_confirmed');
  setMailField(fields, 'produkty', attemptProductLines(attempt.products));
  setMailField(fields, 'uslugi_dodatkowe', attemptExtraServiceLines(attempt.extraServices));
  setMailField(fields, 'miejscowosc', context.city, 80);
  setMailField(fields, 'odleglosc_od_gliwic_km', String(context.distance), 32);
  setMailField(fields, 'rodzaj_mebla', context.furnitureType, 80);
  setMailField(fields, 'dodatkowe_informacje', context.details || 'Nie podano', 2_000);
  setMailField(fields, 'imie', context.contact.name || 'Nie podano', 80);
  setMailField(fields, 'telefon', context.contact.phone || 'Nie podano', 20);
  setMailField(fields, 'email_klienta', context.contact.email || 'Nie podano', 254);
  setMailField(fields, 'wynik', 'Nie wygenerowano kwoty końcowej. Wymagana jest indywidualna wycena.');
  return fields;
}

function notificationFields(payload) {
  return payload.eventType === 'price_not_confirmed'
    ? failedAttemptNotificationFields(payload)
    : automaticNotificationFields(payload);
}

function cleanupMemory(now) {
  for (const [key, expiresAt] of memorySent) if (expiresAt <= now) memorySent.delete(key);
  for (const [key, state] of memoryRate) if (state.expiresAt <= now) memoryRate.delete(key);
}

function deliveryKey(payload) {
  return typeof payload.notificationKey === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(payload.notificationKey)
    ? payload.notificationKey
    : payload.quoteId;
}

async function alreadySent(env, payload) {
  const key = deliveryKey(payload);
  if (memorySent.has(key)) return true;
  return Boolean(
    await env.QUOTE_NOTIFICATION_KV.get(`notification:${payload.quoteId}`)
    || await env.QUOTE_NOTIFICATION_KV.get(`notification-dedupe:${key}`)
  );
}

async function checkRateLimit(env, clientFingerprint, now) {
  const hour = Math.floor(now / 3_600_000);
  const key = `${clientFingerprint}:${hour}`;
  const memory = memoryRate.get(key) || { count: 0, expiresAt: (hour + 1) * 3_600_000 };
  // KV ma spójność eventual i operacje get/put nie są globalnie atomowe. Jest to
  // ochrona best-effort; mapy poniżej wzmacniają ją tylko w obrębie jednego isolate.
  const stored = Number(await env.QUOTE_NOTIFICATION_KV.get(`rate:${key}`) || 0);
  const count = Math.max(memory.count, stored);
  if (count >= RATE_LIMIT_PER_HOUR) return false;
  const next = count + 1;
  memoryRate.set(key, { count: next, expiresAt: memory.expiresAt });
  await env.QUOTE_NOTIFICATION_KV.put(`rate:${key}`, String(next), { expirationTtl: 3_700 });
  return true;
}

async function deliver(payload, env, endpoint) {
  const now = Date.now();
  cleanupMemory(now);
  if (await alreadySent(env, payload)) return jsonResponse({ sent: false, error: 'notification-already-sent' }, { status: 409 });
  if (!await checkRateLimit(env, payload.clientFingerprint, now)) return jsonResponse({ sent: false, error: 'rate-limit' }, { status: 429 });

  const fields = notificationFields(payload);
  const dryRun = env.NOTIFICATION_DRY_RUN === '1';
  if (!dryRun && env.QUOTE_NOTIFICATION_MODE !== 'test') {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: fields,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return jsonResponse({ sent: false, error: 'delivery-failed' }, { status: 502 });
  }

  const key = deliveryKey(payload);
  memorySent.set(key, payload.expiresAt);
  // Rekord replay żyje dłużej niż 20-minutowy token. KV pozostaje best-effort,
  // natomiast inFlight chroni dodatkowo równoległe wywołania w tym samym isolate.
  await env.QUOTE_NOTIFICATION_KV.put(`notification:${payload.quoteId}`, '1', { expirationTtl: NOTIFICATION_RECORD_TTL_SECONDS });
  await env.QUOTE_NOTIFICATION_KV.put(`notification-dedupe:${key}`, '1', { expirationTtl: NOTIFICATION_RECORD_TTL_SECONDS });
  if (dryRun) {
    return jsonResponse({
      sent: false,
      dryRun: true,
      mode: 'notification-dry-run',
      fields: [...fields.keys()]
    }, { status: 200 });
  }
  return jsonResponse({ sent: true, testMode: env.QUOTE_NOTIFICATION_MODE === 'test' }, { status: 200 });
}

export async function onRequestPost({ request, env }) {
  if (!acceptsJson(request)) return jsonResponse({ sent: false, error: 'unsupported-media-type' }, { status: 415 });
  let rawBody;
  try {
    rawBody = await readLimitedRequest(request);
  } catch (error) {
    if (error?.message === 'request-too-large') return jsonResponse({ sent: false, error: 'request-too-large' }, { status: 413 });
    return jsonResponse({ sent: false, error: 'invalid-token' }, { status: 400 });
  }
  if (!env?.QUOTE_NOTIFICATION_KV) return jsonResponse({ sent: false, error: 'notification-not-configured' }, { status: 503 });
  const dryRun = env.NOTIFICATION_DRY_RUN === '1';
  const endpoint = configuredFormspreeEndpoint(env);
  if (!dryRun && !endpoint) return jsonResponse({ sent: false, error: 'notification-not-configured' }, { status: 503 });

  let allowed;
  try {
    allowed = await withinIngressRateLimit(env, request);
  } catch {
    return jsonResponse({ sent: false, error: 'notification-temporarily-unavailable' }, { status: 503 });
  }
  if (!allowed) {
    return jsonResponse({ sent: false, error: 'rate-limit' }, { status: 429, headers: { 'Retry-After': '60' } });
  }

  let payload;
  try {
    const body = JSON.parse(rawBody);
    if (typeof body?.token !== 'string' || body.token.length > MAX_TOKEN_LENGTH) throw new Error('invalid-token');
    payload = await verifyQuoteToken(body?.token, env);
  } catch {
    return jsonResponse({ sent: false, error: 'invalid-token' }, { status: 400 });
  }

  try {
    const key = deliveryKey(payload);
    if (inFlight.has(key)) return (await inFlight.get(key)).clone();
    const delivery = deliver(payload, env, endpoint).finally(() => inFlight.delete(key));
    inFlight.set(key, delivery);
    return await delivery;
  } catch {
    return jsonResponse({ sent: false, error: 'notification-temporarily-unavailable' }, { status: 503 });
  }
}
