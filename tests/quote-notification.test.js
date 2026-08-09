import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequestPost as calculateQuote, TOKEN_LIFETIME_MS } from '../functions/api/quote-products.js';
import { onRequestPost as notifyQuote } from '../functions/api/quote-notification.js';

const SECRET = 'testowy-sekret-powiadomien-ma-co-najmniej-32-znaki';
const NOTIFICATION_ENDPOINT = 'https://formspree.io/f/testquoteendpoint';
const PRODUCT_HTML = (name, price) => `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'Product', name, offers: { price, priceCurrency: 'PLN' }
})}</script></head></html>`;

class FakeKv {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, String(value)); }
}

function env(overrides = {}) {
  return {
    QUOTE_NOTIFICATION_SECRET: SECRET,
    QUOTE_NOTIFICATION_KV: new FakeKv(),
    QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT: NOTIFICATION_ENDPOINT,
    ...overrides
  };
}

function body(items, overrides = {}) {
  return {
    items,
    city: 'Gliwice',
    distance: 0,
    furnitureType: 'Meble z paczek',
    details: '',
    contact: { name: '', phone: '', email: '' },
    ...overrides
  };
}

function request(path, value, userAgent = 'Meblofix test') {
  return new Request(`https://meblofix-gliwice.pl${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent, 'cf-connecting-ip': '203.0.113.10' },
    body: JSON.stringify(value)
  });
}

function tokenPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function installFetchMock({ products = {}, deliveries, deliveryStatus = 200 }) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === NOTIFICATION_ENDPOINT) {
      deliveries.push(Object.fromEntries(init.body.entries()));
      return Response.json({ ok: deliveryStatus < 400 }, { status: deliveryStatus });
    }
    if (url in products) return new Response(products[url], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    throw new Error(`Nieprzechwycony request testowy: ${url}`);
  };
  return () => { globalThis.fetch = original; };
}

async function calculate(value, bindings = env(), userAgent) {
  const response = await calculateQuote({ request: request('/api/quote-products', value, userAgent), env: bindings });
  return { response, data: await response.json() };
}

async function notify(token, bindings, extra = {}) {
  const response = await notifyQuote({ request: request('/api/quote-notification', { token, ...extra }), env: bindings });
  return { response, data: await response.json() };
}

test('poprawna wycena jednego produktu wysyła dokładnie jedno powiadomienie', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-one/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Szafa TEST', 1000) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-one');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.quote.total, 200);
    assert.equal(deliveries.length, 0, 'obliczenie nie wysyła e-maila przed pokazaniem wyniku');
    const notification = await notify(result.data.notificationToken, bindings);
    assert.equal(notification.response.status, 200);
    assert.equal(notification.data.sent, true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]._subject, 'Nowa wycena z kalkulatora Meblofix');
    assert.ok(deliveries[0].data_i_godzina);
    assert.equal(deliveries[0].laczna_wartosc_produktow, '1000 zł');
    assert.equal(deliveries[0].koszt_montazu, '200 zł');
    assert.equal(deliveries[0].koszt_dojazdu, '0 zł');
    assert.equal(deliveries[0].laczna_orientacyjna_wycena, '200 zł');
    assert.equal(deliveries[0].rodzaj_mebla, 'Meble z paczek');
  } finally { restore(); }
});

test('kilka produktów zachowuje wszystkie linki, ilości i potwierdzone ceny', async () => {
  const deliveries = [];
  const first = 'https://www.ikea.com/pl/pl/p/test-first/';
  const second = 'https://www.brw.pl/test-second/';
  const restore = installFetchMock({ products: { [first]: PRODUCT_HTML('Regał', 300), [second]: PRODUCT_HTML('Biurko', 500) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url: first, quantity: 2 }, { url: second, quantity: 3 }]), bindings, 'test-many');
    assert.equal(result.data.quote.furniture, 2100);
    await notify(result.data.notificationToken, bindings);
    assert.equal(deliveries.length, 1);
    const products = deliveries[0].produkty;
    assert.match(products, /test-first/);
    assert.match(products, /Ilość: 2/);
    assert.match(products, /Potwierdzona cena sztuki: 300 zł/);
    assert.match(products, /test-second/);
    assert.match(products, /Ilość: 3/);
    assert.match(products, /Potwierdzona cena sztuki: 500 zł/);
  } finally { restore(); }
});

test('błędny link nie tworzy tokenu i nie wysyła fałszywego powiadomienia', async () => {
  const deliveries = [];
  const restore = installFetchMock({ deliveries });
  try {
    const result = await calculate(body([{ url: 'https://example.com/produkt', quantity: 1 }]), env(), 'test-invalid');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.allConfirmed, false);
    assert.equal(result.data.notificationToken, undefined);
    assert.equal(deliveries.length, 0);
  } finally { restore(); }
});

test('projekt IKEA Planner pozostaje wyceną indywidualną bez powiadomienia o sukcesie', async () => {
  const deliveries = [];
  const url = 'https://kitchen.planner.ikea.com/pl/pl/planner/12345678-1234-1234-1234-123456789abc/';
  const restore = installFetchMock({ products: { [url]: '<!doctype html><html></html>' }, deliveries });
  try {
    const result = await calculate(body([{ url, quantity: 1 }]), env(), 'test-planner');
    assert.equal(result.data.allConfirmed, false);
    assert.equal(result.data.products[0].kind, 'ikea-project');
    assert.equal(result.data.notificationToken, undefined);
    assert.equal(deliveries.length, 0);
  } finally { restore(); }
});

test('równoległe powtórzenie tego samego powiadomienia nie wysyła dwóch e-maili', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-double/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Komoda', 800) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-double');
    const responses = await Promise.all([notify(result.data.notificationToken, bindings), notify(result.data.notificationToken, bindings)]);
    assert.equal(responses.some(item => item.response.status === 200), true);
    assert.equal(responses.every(item => [200, 409].includes(item.response.status)), true);
    assert.equal(deliveries.length, 1);
  } finally { restore(); }
});

test('dwie identyczne wyceny otrzymują dwa różne losowe quoteId', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-identical/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Szafka', 700) }, deliveries });
  try {
    const bindings = env();
    const input = body([{ url, quantity: 1 }]);
    const first = await calculate(input, bindings, 'ten-sam-klient');
    const second = await calculate(input, bindings, 'ten-sam-klient');
    assert.notEqual(first.data.quoteId, second.data.quoteId);
    assert.match(first.data.quoteId, /^[0-9a-f-]{36}$/i);
    assert.match(second.data.quoteId, /^[0-9a-f-]{36}$/i);
    const payload = tokenPayload(first.data.notificationToken);
    assert.equal(payload.expiresAt - payload.issuedAt, TOKEN_LIFETIME_MS);
  } finally { restore(); }
});

test('ponowne użycie quoteId po udanej wysyłce jest odrzucane', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-replay/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Komoda', 800) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-replay');
    assert.equal((await notify(result.data.notificationToken, bindings)).response.status, 200);
    const replay = await notify(result.data.notificationToken, bindings);
    assert.equal(replay.response.status, 409);
    assert.equal(replay.data.error, 'notification-already-sent');
    assert.equal(deliveries.length, 1);
    assert.equal(await bindings.QUOTE_NOTIFICATION_KV.get(`notification:${result.data.quoteId}`), '1');
  } finally { restore(); }
});

test('zmodyfikowany i wygasły token są odrzucane', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-token/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Regał', 650) }, deliveries });
  const realNow = Date.now;
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-token');
    const parts = result.data.notificationToken.split('.');
    const changed = `${parts[0]}.${parts[1].slice(0, -1)}${parts[1].endsWith('a') ? 'b' : 'a'}.${parts[2]}`;
    assert.equal((await notify(changed, bindings)).response.status, 400);

    Date.now = () => realNow() + TOKEN_LIFETIME_MS + 1_000;
    assert.equal((await notify(result.data.notificationToken, bindings)).response.status, 400);
    assert.equal(deliveries.length, 0);
  } finally {
    Date.now = realNow;
    restore();
  }
});

test('brak danych kontaktowych nie blokuje technicznego powiadomienia', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-anon/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Stół', 600) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-anon');
    await notify(result.data.notificationToken, bindings);
    assert.equal(deliveries[0].imie, 'Nie podano');
    assert.equal(deliveries[0].telefon, 'Nie podano');
    assert.equal(deliveries[0].email_klienta, 'Nie podano');
  } finally { restore(); }
});

test('dane podane przed wyceną trafiają do powiadomienia', async () => {
  const deliveries = [];
  const url = 'https://www.brw.pl/test-contact/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Łóżko', 1200) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }], {
      city: 'Zabrze', distance: 12, details: 'Mieszkanie na trzecim piętrze.',
      contact: { name: 'Jan', phone: '500 600 700', email: 'jan@example.com' }
    }), bindings, 'test-contact');
    await notify(result.data.notificationToken, bindings);
    assert.equal(deliveries[0].imie, 'Jan');
    assert.equal(deliveries[0].telefon, '500 600 700');
    assert.equal(deliveries[0].email_klienta, 'jan@example.com');
    assert.equal(deliveries[0].dodatkowe_informacje, 'Mieszkanie na trzecim piętrze.');
    assert.equal(deliveries[0].miejscowosc, 'Zabrze');
    assert.equal(deliveries[0].odleglosc_od_gliwic_km, '12');
    assert.equal(deliveries[0].laczna_orientacyjna_wycena, '276 zł');
  } finally { restore(); }
});

test('podrobiony token i brak magazynu antyspamowego są odrzucane', async () => {
  const invalid = await notify('v1.podrobiony.token', env());
  assert.equal(invalid.response.status, 400);
  const missingKv = await notify('dowolny', {
    QUOTE_NOTIFICATION_SECRET: SECRET,
    QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT: NOTIFICATION_ENDPOINT
  });
  assert.equal(missingKv.response.status, 503);
});

test('brak osobnego endpointu Formspree daje kontrolowany błąd bez wysyłki', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-missing-endpoint/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Stół', 900) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-config');
    const withoutEndpoint = { ...bindings, QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT: '' };
    const notification = await notify(result.data.notificationToken, withoutEndpoint);
    assert.equal(notification.response.status, 503);
    assert.equal(notification.data.error, 'notification-not-configured');
    assert.equal(deliveries.length, 0);
  } finally { restore(); }
});

test('chwilowa awaria KV daje kontrolowany błąd bez próby wysyłki', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-kv-failure/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Witryna', 1100) }, deliveries });
  try {
    const signingBindings = env();
    const result = await calculate(body([{ url, quantity: 1 }]), signingBindings, 'test-kv-failure');
    const failingKv = {
      async get() { throw new Error('symulowana awaria KV'); },
      async put() { throw new Error('symulowana awaria KV'); }
    };
    const notification = await notify(result.data.notificationToken, {
      ...signingBindings,
      QUOTE_NOTIFICATION_KV: failingKv
    });
    assert.equal(notification.response.status, 503);
    assert.equal(notification.data.error, 'notification-temporarily-unavailable');
    assert.equal(deliveries.length, 0);
  } finally { restore(); }
});

test('frontend nie może wskazać endpointu ani zmienić podpisanych kwot', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-untrusted-fields/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Szafa', 1000) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-untrusted');
    const notification = await notify(result.data.notificationToken, bindings, {
      endpoint: 'https://attacker.example/collect',
      recipient: 'attacker@example.com',
      quote: { total: 1, installation: 1, products: [{ price: 1 }] }
    });
    assert.equal(notification.response.status, 200);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].laczna_wartosc_produktow, '1000 zł');
    assert.equal(deliveries[0].koszt_montazu, '200 zł');
    assert.equal(deliveries[0].laczna_orientacyjna_wycena, '200 zł');
  } finally { restore(); }
});

test('awaria Formspree zwraca techniczny błąd bez fałszywego sukcesu', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-formspree-failure/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Biurko', 500) }, deliveries, deliveryStatus: 500 });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-formspree-failure');
    const notification = await notify(result.data.notificationToken, bindings);
    assert.equal(notification.response.status, 502);
    assert.equal(notification.data.error, 'delivery-failed');
    assert.equal(deliveries.length, 1);
  } finally { restore(); }
});

test('limit godzinowy zatrzymuje szóstą wiadomość z tego samego klienta', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-rate/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Krzesło', 200) }, deliveries });
  try {
    const bindings = env();
    const statuses = [];
    for (let index = 1; index <= 6; index += 1) {
      const result = await calculate(body([{ url, quantity: 1 }], { details: `Wariant ${index}` }), bindings, 'test-rate');
      statuses.push((await notify(result.data.notificationToken, bindings)).response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    assert.equal(deliveries.length, 5);
  } finally { restore(); }
});

test('brak sekretu nie usuwa poprawnej wyceny, ale nie tworzy tokenu', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-no-secret/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Półka', 300) }, deliveries });
  try {
    const result = await calculate(body([{ url: 'https://www.ikea.com/pl/pl/p/test-no-secret/', quantity: 1 }]), {
      QUOTE_NOTIFICATION_KV: new FakeKv(),
      QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT: NOTIFICATION_ENDPOINT
    }, 'test-no-secret');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.allConfirmed, true);
    assert.equal(result.data.quote.total, 150);
    assert.equal(result.data.notificationToken, null);
    assert.equal(deliveries.length, 0);
  } finally { restore(); }
});

test('frontend nie zawiera reguły procentowej ani technicznego minimum', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const calculator = html.slice(html.indexOf('// ─── KALKULATOR OPARTY WYŁĄCZNIE NA LINKACH ───'), html.indexOf('function createStarIcon'));
  assert.doesNotMatch(calculator, /installationRate|minimumJob|travelPerKm|QUOTE_RULES|20%|150 zł/);
  assert.match(calculator, /\/api\/quote-notification/);
  assert.doesNotMatch(calculator, /QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT|formspree\.io\/f\/testquoteendpoint/);
});
