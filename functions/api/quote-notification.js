import { verifyQuoteToken } from './quote-products.js';

const RATE_LIMIT_PER_HOUR = 5;
const NOTIFICATION_RECORD_TTL_SECONDS = 30 * 60;
const memorySent = new Map();
const memoryRate = new Map();
const inFlight = new Map();

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
  fields.set('_subject', 'Nowa wycena z kalkulatora Meblofix');
  fields.set('typ_zdarzenia', 'AUTOMATYCZNA_WYCENA');
  fields.set('data_i_godzina', polishDate(payload.issuedAt));
  fields.set('identyfikator_wyceny', payload.quoteId);
  fields.set('produkty', productLines(quote.products));
  fields.set('laczna_wartosc_produktow', money(quote.furniture));
  fields.set('koszt_montazu', money(quote.installation));
  fields.set('uslugi_dodatkowe', extraServiceLines(quote.extraServices));
  fields.set('laczny_koszt_uslug_dodatkowych', money(quote.extraServicesTotal || 0));
  fields.set('koszt_dojazdu', money(quote.travel));
  fields.set('laczna_orientacyjna_wycena', money(quote.total));
  fields.set('miejscowosc', context.city);
  fields.set('odleglosc_od_gliwic_km', String(context.distance));
  fields.set('rodzaj_mebla', context.furnitureType);
  fields.set('dodatkowe_informacje', context.details || 'Nie podano');
  fields.set('imie', context.contact.name || 'Nie podano');
  fields.set('telefon', context.contact.phone || 'Nie podano');
  fields.set('email_klienta', context.contact.email || 'Nie podano');
  fields.set('dane_techniczne', 'Montaż: 20% wartości produktów, minimum techniczne 150 zł. Dojazd: odległość w jedną stronę × 2 × 1,50 zł. Kwoty obliczone i podpisane po stronie serwera.');
  return fields;
}


export function failedAttemptNotificationFields(payload) {
  const { attempt, context } = payload;
  const fields = new FormData();
  fields.set('_subject', 'Nieudana próba automatycznej wyceny');
  fields.set('typ_zdarzenia', 'NIEUDANA_PROBA_AUTOMATYCZNEJ_WYCENY');
  fields.set('data_i_godzina', polishDate(payload.issuedAt));
  fields.set('identyfikator_proby', payload.quoteId);
  fields.set('przyczyna', 'price_not_confirmed');
  fields.set('produkty', attemptProductLines(attempt.products));
  fields.set('uslugi_dodatkowe', attemptExtraServiceLines(attempt.extraServices));
  fields.set('miejscowosc', context.city);
  fields.set('odleglosc_od_gliwic_km', String(context.distance));
  fields.set('rodzaj_mebla', context.furnitureType);
  fields.set('dodatkowe_informacje', context.details || 'Nie podano');
  fields.set('imie', context.contact.name || 'Nie podano');
  fields.set('telefon', context.contact.phone || 'Nie podano');
  fields.set('email_klienta', context.contact.email || 'Nie podano');
  fields.set('wynik', 'Nie wygenerowano kwoty końcowej. Wymagana jest indywidualna wycena.');
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
  if (await alreadySent(env, payload)) return Response.json({ sent: false, error: 'notification-already-sent' }, { status: 409 });
  if (!await checkRateLimit(env, payload.clientFingerprint, now)) return Response.json({ sent: false, error: 'rate-limit' }, { status: 429 });

  if (env.QUOTE_NOTIFICATION_MODE !== 'test') {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: notificationFields(payload),
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) return Response.json({ sent: false, error: 'delivery-failed' }, { status: 502 });
  }

  const key = deliveryKey(payload);
  memorySent.set(key, payload.expiresAt);
  // Rekord replay żyje dłużej niż 20-minutowy token. KV pozostaje best-effort,
  // natomiast inFlight chroni dodatkowo równoległe wywołania w tym samym isolate.
  await env.QUOTE_NOTIFICATION_KV.put(`notification:${payload.quoteId}`, '1', { expirationTtl: NOTIFICATION_RECORD_TTL_SECONDS });
  await env.QUOTE_NOTIFICATION_KV.put(`notification-dedupe:${key}`, '1', { expirationTtl: NOTIFICATION_RECORD_TTL_SECONDS });
  return Response.json({ sent: true, testMode: env.QUOTE_NOTIFICATION_MODE === 'test' }, { status: 200 });
}

export async function onRequestPost({ request, env }) {
  if (!env?.QUOTE_NOTIFICATION_KV) return Response.json({ sent: false, error: 'notification-not-configured' }, { status: 503 });
  const endpoint = configuredFormspreeEndpoint(env);
  if (!endpoint) return Response.json({ sent: false, error: 'notification-not-configured' }, { status: 503 });

  let payload;
  try {
    const body = await request.json();
    payload = await verifyQuoteToken(body?.token, env);
  } catch {
    return Response.json({ sent: false, error: 'invalid-token' }, { status: 400 });
  }

  try {
    const key = deliveryKey(payload);
    if (inFlight.has(key)) return (await inFlight.get(key)).clone();
    const delivery = deliver(payload, env, endpoint).finally(() => inFlight.delete(key));
    inFlight.set(key, delivery);
    return await delivery;
  } catch {
    return Response.json({ sent: false, error: 'notification-temporarily-unavailable' }, { status: 503 });
  }
}
