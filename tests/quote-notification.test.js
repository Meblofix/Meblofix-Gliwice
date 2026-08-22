import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { onRequestPost as calculateQuote, TOKEN_LIFETIME_MS, verifyQuoteToken } from '../functions/api/quote-products.js';
import { onRequestPost as notifyQuote } from '../functions/api/quote-notification.js';

const SECRET = 'testowy-sekret-powiadomien-ma-co-najmniej-32-znaki';
const NOTIFICATION_ENDPOINT = 'https://formspree.io/f/testquoteendpoint';
const TELEGRAM_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TELEGRAM_CHAT_ID = '-1001234567890';
const TELEGRAM_ENDPOINT = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
const ALLEGRO_URL = 'https://allegro.pl/produkt/lozko-pojedyncze-ikea-hemnes-drewniane-biale-80x200-z-pojemnikiem-34f7722e-546b-437d-a88d-2d618d6728d0?offerId=18281158355';
const ALLEGRO_NAME = 'IKEA HEMNES łóżko składane, leżanka 3 szufladami biały 80x200';
const PLANNER_MESSAGE = 'Projekt z planera IKEA wyceniamy indywidualnie. Prześlij dane kontaktowe, a przygotujemy ręczną wycenę na podstawie projektu.';
const UNSUPPORTED_MESSAGE = 'Podaj link do strony produktu w obsługiwanym sklepie. Jeśli produktu nie ma na liście obsługiwanych sklepów, prześlij dane kontaktowe — przygotujemy wycenę indywidualną.';
const ALLEGRO_VISIBLE_HTML = `<!doctype html><html><head><meta property="og:title" content="${ALLEGRO_NAME}"></head><body>
  <h1>${ALLEGRO_NAME}</h1>
  <section><h2>Warunki oferty</h2><p>dla biznesu</p><p>cena 1399,00&nbsp;zł</p></section>
  <section><h2>Opcje zakupu</h2><p>Dostawa od 400,00 zł</p></section>
  <footer>Numer oferty: 18281158355</footer>
</body></html>`;
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

function rawRequest(path, rawBody, contentType = 'application/json', origin = 'https://meblofix-gliwice.pl') {
  return new Request(`https://meblofix-gliwice.pl${path}`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      origin,
      'user-agent': 'Meblofix security test',
      'cf-connecting-ip': '203.0.113.20'
    },
    body: rawBody
  });
}

async function tokenPayload(token, bindings) { return verifyQuoteToken(token, bindings); }

function installFetchMock({
  products = {},
  deliveries,
  deliveryStatus = 200,
  requests = [],
  telegramDeliveries = [],
  telegramStatus = 200
}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === NOTIFICATION_ENDPOINT) {
      deliveries.push(Object.fromEntries(init.body.entries()));
      return Response.json({ ok: deliveryStatus < 400 }, { status: deliveryStatus });
    }
    if (url === TELEGRAM_ENDPOINT) {
      telegramDeliveries.push(JSON.parse(init.body));
      return Response.json({ ok: telegramStatus < 400 }, { status: telegramStatus });
    }
    if (url in products) {
      requests.push({ url, init });
      const entry = products[url];
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
        return new Response(entry.body ?? '', {
          status: entry.status ?? 200,
          headers: { 'content-type': 'text/html; charset=utf-8', ...(entry.headers || {}) }
        });
      }
      return new Response(entry, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
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
    assert.equal(deliveries[0].uslugi_dodatkowe, 'Nie wybrano');
    assert.equal(deliveries[0].laczny_koszt_uslug_dodatkowych, '0 zł');
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
    assert.match(products, /Sklep: IKEA/);
    assert.match(products, /Sklep: BRW/);
    assert.doesNotMatch(products, /https?:\/\//i);
  } finally { restore(); }
});

test('pole produktów zachowuje identyfikatory bez surowych protokołów i bez duplikowania adresów', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/metod-szafka-12345678/?utm_source=test';
  const reference = 'ikea.com/pl/pl/p/metod-szafka-12345678/?utm_source=test';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Szafka METOD', 750) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 2 }]), bindings, 'test-no-raw-product-url');
    await notify(result.data.notificationToken, bindings);
    const products = deliveries[0].produkty;
    assert.match(products, /Sklep: IKEA/);
    assert.match(products, /Produkt: Szafka METOD/);
    assert.match(products, /Ilość: 2/);
    assert.match(products, /Potwierdzona cena sztuki: 750 zł/);
    assert.match(products, /Identyfikator produktu: ikea\.com\/pl\/pl\/p\/metod-szafka-12345678\/\?utm_source=test/);
    assert.doesNotMatch(products, /https?:\/\//i);
    assert.equal(products.split(reference).length - 1, 1);
  } finally { restore(); }
});

test('Allegro potwierdza 1399 PLN tylko z sekcji właściwej oferty', async () => {
  const deliveries = [];
  const requests = [];
  const restore = installFetchMock({ products: { [ALLEGRO_URL]: ALLEGRO_VISIBLE_HTML }, deliveries, requests });
  try {
    const result = await calculate(body([{ url: ALLEGRO_URL, quantity: 1 }]), env(), 'test-allegro-visible');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.allConfirmed, true);
    assert.equal(result.data.products[0].store, 'Allegro');
    assert.equal(result.data.products[0].offerId, '18281158355');
    assert.equal(result.data.products[0].name, ALLEGRO_NAME);
    assert.equal(result.data.products[0].price, 1399);
    assert.equal(result.data.quote.furniture, 1399);
    assert.equal(result.data.quote.installation, 279.8);
    assert.equal(result.data.quote.total, 279.8);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.redirect, 'manual');
    assert.match(requests[0].init.headers['User-Agent'], /Mozilla\/5\.0/);
  } finally { restore(); }
});

test('Allegro akceptuje poprawny JSON-LD wyłącznie z identyfikatorem właściwej oferty', async () => {
  const deliveries = [];
  const html = `<!doctype html><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: ALLEGRO_NAME,
    offers: { '@type': 'Offer', sku: '18281158355', price: '1399.00', priceCurrency: 'PLN' }
  })}</script>`;
  const restore = installFetchMock({ products: { [ALLEGRO_URL]: html }, deliveries });
  try {
    const result = await calculate(body([{ url: ALLEGRO_URL, quantity: 1 }]), env(), 'test-allegro-jsonld');
    assert.equal(result.data.allConfirmed, true);
    assert.equal(result.data.products[0].price, 1399);
  } finally { restore(); }
});

test('Allegro bez ceny pozostaje wyceną indywidualną', async () => {
  const deliveries = [];
  const html = `<html><h1>${ALLEGRO_NAME}</h1><h2>Warunki oferty</h2><p>Brak aktywnej ceny</p><h2>Opcje zakupu</h2><p>Numer oferty: 18281158355</p></html>`;
  const restore = installFetchMock({ products: { [ALLEGRO_URL]: html }, deliveries });
  try {
    const result = await calculate(body([{ url: ALLEGRO_URL, quantity: 1 }]), env(), 'test-allegro-no-price');
    assert.equal(result.data.allConfirmed, false);
    assert.equal(result.data.quote, undefined);
    assert.ok(result.data.notificationToken);
  } finally { restore(); }
});

test('błędny link Allegro jest odrzucany przed pobraniem strony', async () => {
  const deliveries = [];
  const requests = [];
  const restore = installFetchMock({ deliveries, requests });
  try {
    const result = await calculate(body([{ url: 'https://allegro.pl/produkt/bledny-link', quantity: 1 }]), env(), 'test-allegro-invalid');
    assert.equal(result.data.allConfirmed, false);
    assert.match(result.data.products[0].error, /Nieprawidłowy link do oferty Allegro/);
    assert.equal(requests.length, 0);
  } finally { restore(); }
});

test('redirect Allegro przechodzi tylko do ponownie zwalidowanego oficjalnego hosta', async () => {
  const deliveries = [];
  const redirected = ALLEGRO_URL.replace('https://allegro.pl/', 'https://www.allegro.pl/');
  const restore = installFetchMock({ products: {
    [ALLEGRO_URL]: { status: 302, headers: { location: redirected } },
    [redirected]: ALLEGRO_VISIBLE_HTML
  }, deliveries });
  try {
    const result = await calculate(body([{ url: ALLEGRO_URL, quantity: 1 }]), env(), 'test-allegro-redirect');
    assert.equal(result.data.allConfirmed, true);
    assert.equal(result.data.products[0].price, 1399);
  } finally { restore(); }
});

test('błędna waluta i brak ceny nie tworzą automatycznej kwoty', async () => {
  const deliveries = [];
  const euro = 'https://www.ikea.com/pl/pl/p/test-euro/';
  const missing = 'https://www.brw.pl/test-missing-price/';
  const euroHtml = `<!doctype html><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product', name: 'Produkt EUR', offers: { price: 120, priceCurrency: 'EUR' }
  })}</script>`;
  const restore = installFetchMock({ products: { [euro]: euroHtml, [missing]: '<html><title>Bez ceny</title></html>' }, deliveries });
  try {
    const wrongCurrency = await calculate(body([{ url: euro, quantity: 1 }]), env(), 'test-euro');
    const noPrice = await calculate(body([{ url: missing, quantity: 1 }]), env(), 'test-missing-price');
    assert.equal(wrongCurrency.data.allConfirmed, false);
    assert.equal(noPrice.data.allConfirmed, false);
    assert.equal(wrongCurrency.data.quote, undefined);
    assert.equal(noPrice.data.quote, undefined);
  } finally { restore(); }
});

test('IKEA, BRW, Agata i Jysk zachowują działający parser JSON-LD', async () => {
  const deliveries = [];
  const stores = [
    'https://www.ikea.com/pl/pl/p/regression/',
    'https://www.brw.pl/regression/',
    'https://www.agatameble.pl/regression/',
    'https://www.jysk.pl/regression/'
  ];
  const products = Object.fromEntries(stores.map((url, index) => [url, PRODUCT_HTML(`Produkt ${index + 1}`, 100 + index)]));
  const restore = installFetchMock({ products, deliveries });
  try {
    const result = await calculate(body(stores.map(url => ({ url, quantity: 1 }))), env(), 'test-stores-regression');
    assert.equal(result.data.allConfirmed, true);
    assert.deepEqual(result.data.products.map(product => product.price), [100, 101, 102, 103]);
  } finally { restore(); }
});

test('próba SSRF nadal jest blokowana bez wykonania pobrania', async () => {
  const deliveries = [];
  const requests = [];
  const restore = installFetchMock({ deliveries, requests });
  try {
    const result = await calculate(body([{ url: 'http://127.0.0.1/produkt', quantity: 1 }]), env(), 'test-ssrf');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.allConfirmed, false);
    assert.ok(result.data.notificationToken);
    assert.equal(result.data.products[0].kind, 'unsupported-url');
    assert.equal(result.data.products[0].message, UNSUPPORTED_MESSAGE);
    assert.equal(requests.length, 0);
    assert.equal(deliveries.length, 0);
  } finally { restore(); }
});

test('link z planera kuchni IKEA uruchamia wycenę indywidualną i poprawnie oznaczone powiadomienie', async () => {
  const deliveries = [];
  const requests = [];
  const url = 'https://kitchen.planner.ikea.com/pl/pl/planner/Projekt_Kuchni-123/?ref=share';
  const bindings = env();
  const restore = installFetchMock({ deliveries, requests });
  try {
    const result = await calculate(body([{ url, quantity: 1 }], {
      city: 'Zabrze', distance: 11, details: 'Montaż całej kuchni.',
      contact: { name: 'Anna', phone: '500 111 222', email: 'anna@example.com' }
    }), bindings, 'test-planner');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.allConfirmed, false);
    assert.equal(result.data.products[0].kind, 'ikea-planner');
    assert.equal(result.data.products[0].plannerType, 'kitchen');
    assert.equal(result.data.products[0].message, PLANNER_MESSAGE);
    assert.deepEqual(result.data.individualQuote, { reason: 'ikea_planner', message: PLANNER_MESSAGE });
    assert.ok(result.data.notificationToken);
    const signed = await tokenPayload(result.data.notificationToken, bindings);
    assert.equal(signed.eventType, 'individual_quote');
    assert.equal(signed.reason, 'ikea_planner');
    assert.equal(requests.length, 0, 'aplikacja planera nie może być pobierana ani parsowana');
    const notification = await notify(result.data.notificationToken, bindings);
    assert.equal(notification.response.status, 200);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]._subject, 'Nowe zapytanie o wycenę indywidualną');
    assert.equal(deliveries[0].typ_zdarzenia, 'Zapytanie o wycenę indywidualną');
    assert.equal(deliveries[0].przyczyna, 'ikea_planner');
    assert.match(deliveries[0].pozycje_zgloszenia, /Identyfikator produktu: kitchen\.planner\.ikea\.com\/pl\/pl\/planner\/Projekt_Kuchni-123\/\?ref=share/);
    assert.doesNotMatch(deliveries[0].pozycje_zgloszenia, /https?:\/\//i);
    assert.equal(deliveries[0].pozycje_zgloszenia.split('kitchen.planner.ikea.com').length - 1, 1);
    assert.equal(deliveries[0].miejscowosc, 'Zabrze');
    assert.equal(deliveries[0].odleglosc_od_gliwic_km, '11');
    assert.equal(deliveries[0].dodatkowe_informacje, 'Montaż całej kuchni.');
    assert.equal(deliveries[0].imie, 'Anna');
    assert.equal(deliveries[0].telefon, '500 111 222');
    assert.equal(deliveries[0].email_klienta, 'anna@example.com');
    assert.doesNotMatch(deliveries[0].typ_zdarzenia, /NIEUDANA/);
  } finally { restore(); }
});

test('oficjalny planer szaf IKEA PAX jest rozpoznawany bez pobierania aplikacji', async () => {
  const deliveries = [];
  const requests = [];
  const url = 'https://www.ikea.com/addon-app/storageone/pax/web/latest/pl/pl/#/projekt-testowy';
  const restore = installFetchMock({ deliveries, requests });
  try {
    const result = await calculate(body([{ url, quantity: 1 }]), env(), 'test-pax-planner');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.products[0].kind, 'ikea-planner');
    assert.equal(result.data.products[0].plannerType, 'pax');
    assert.equal(result.data.products[0].url, url);
    assert.equal(result.data.individualQuote.reason, 'ikea_planner');
    assert.equal(requests.length, 0);
  } finally { restore(); }
});

test('zwykły link do produktu IKEA zachowuje automatyczną wycenę', async () => {
  const deliveries = [];
  const requests = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-zwykly-produkt/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Szafka IKEA', 500) }, deliveries, requests });
  try {
    const result = await calculate(body([{ url, quantity: 1 }]), env(), 'test-ikea-product-unchanged');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.allConfirmed, true);
    assert.equal(result.data.quote.furniture, 500);
    assert.equal((await tokenPayload(result.data.notificationToken, env())).eventType, 'automatic_quote');
    assert.deepEqual(requests.map(item => item.url), [url]);
  } finally { restore(); }
});

test('adres spoza allowlisty oferuje wycenę indywidualną bez szczegółów technicznych', async () => {
  const deliveries = [];
  const requests = [];
  const url = 'https://example.com/mebel/test';
  const restore = installFetchMock({ deliveries, requests });
  try {
    const result = await calculate(body([{ url, quantity: 1 }]), env(), 'test-unsupported-url');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.products[0].kind, 'unsupported-url');
    assert.equal(result.data.products[0].message, UNSUPPORTED_MESSAGE);
    assert.deepEqual(result.data.individualQuote, { reason: 'unsupported_url', message: UNSUPPORTED_MESSAGE });
    assert.equal((await tokenPayload(result.data.notificationToken, env())).eventType, 'individual_quote');
    assert.equal(requests.length, 0);
    assert.doesNotMatch(JSON.stringify(result.data), /SSRF|allowlist|hostname|fetch|stack|exception/i);
  } finally { restore(); }
});

test('mieszany zestaw produktu i planera przechodzi jedną ścieżką wyceny indywidualnej', async () => {
  const deliveries = [];
  const requests = [];
  const productUrl = 'https://www.ikea.com/pl/pl/p/test-produkt-mieszany/';
  const plannerUrl = 'https://kitchen.planner.ikea.com/pl/pl/planner/mixed-project/?ref=share';
  const bindings = env();
  const restore = installFetchMock({ products: { [productUrl]: PRODUCT_HTML('Szafka IKEA', 600) }, deliveries, requests });
  try {
    const result = await calculate(body([
      { url: productUrl, quantity: 2 },
      { url: plannerUrl, quantity: 1 }
    ]), bindings, 'test-mixed-planner');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.allConfirmed, false);
    assert.equal(result.data.individualQuote.reason, 'ikea_planner');
    assert.deepEqual(requests.map(item => item.url), [productUrl]);
    const signed = await tokenPayload(result.data.notificationToken, bindings);
    assert.equal(signed.eventType, 'individual_quote');
    assert.deepEqual(signed.inquiry.products.map(product => product.status), ['price_confirmed', 'ikea_planner']);
    await notify(result.data.notificationToken, bindings);
    assert.match(deliveries[0].pozycje_zgloszenia, /test-produkt-mieszany/);
    assert.match(deliveries[0].pozycje_zgloszenia, /mixed-project/);
    assert.doesNotMatch(deliveries[0].pozycje_zgloszenia, /https?:\/\//i);
    assert.equal(deliveries[0].pozycje_zgloszenia.split('mixed-project').length - 1, 1);
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
    const payload = await tokenPayload(first.data.notificationToken, bindings);
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

test('nieudana wycena wysyła jedno powiadomienie price_not_confirmed bez fałszywej kwoty', async () => {
  const deliveries = [];
  const restore = installFetchMock({ products: { [ALLEGRO_URL]: '<html><h1>Oferta bez ceny</h1></html>' }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url: ALLEGRO_URL, quantity: 2 }], {
      city: 'Zabrze', distance: 11,
      extraServices: [{ serviceId: 'hood_install', quantity: 1 }],
      details: 'Proszę o kontakt po 17:00.',
      contact: { name: 'Anna', phone: '500 111 222', email: 'anna@example.com' }
    }), bindings, 'test-failed-attempt');
    assert.equal(result.data.allConfirmed, false);
    assert.equal(deliveries.length, 0, 'wynik indywidualny ma pojawić się przed osobnym wywołaniem powiadomienia');
    const payload = await tokenPayload(result.data.notificationToken, bindings);
    assert.equal(payload.eventType, 'price_not_confirmed');
    assert.equal(payload.reason, 'price_not_confirmed');
    const notification = await notify(result.data.notificationToken, bindings);
    assert.equal(notification.response.status, 200);
    assert.equal(notification.data.sent, true);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]._subject, 'Nieudana próba automatycznej wyceny');
    assert.equal(deliveries[0].typ_zdarzenia, 'Nieudana próba automatycznej wyceny');
    assert.equal(deliveries[0].przyczyna, 'price_not_confirmed');
    assert.match(deliveries[0].produkty, /offerId=18281158355/);
    assert.match(deliveries[0].produkty, /Ilość: 2/);
    assert.doesNotMatch(deliveries[0].produkty, /https?:\/\//i);
    assert.match(deliveries[0].uslugi_dodatkowe, /Montaż okapu/);
    assert.equal(deliveries[0].miejscowosc, 'Zabrze');
    assert.equal(deliveries[0].dodatkowe_informacje, 'Proszę o kontakt po 17:00.');
    assert.equal(deliveries[0].imie, 'Anna');
    assert.equal(deliveries[0].wynik, 'Nie wygenerowano kwoty końcowej. Wymagana jest indywidualna wycena.');
    assert.equal('laczna_orientacyjna_wycena' in deliveries[0], false);
    assert.equal('koszt_montazu' in deliveries[0], false);
  } finally { restore(); }
});

test('dwa szybkie identyczne kliknięcia nie tworzą dwóch powiadomień', async () => {
  const deliveries = [];
  const url = 'https://www.jysk.pl/test-no-duplicate/';
  const restore = installFetchMock({ products: { [url]: '<html><h1>Brak ceny</h1></html>' }, deliveries });
  const realNow = Date.now;
  try {
    Date.now = () => 1_800_000_000_000;
    const bindings = env();
    const input = body([{ url, quantity: 1 }], { details: 'Ta sama próba' });
    const first = await calculate(input, bindings, 'test-fast-double-click');
    const second = await calculate(input, bindings, 'test-fast-double-click');
    assert.notEqual(first.data.quoteId, second.data.quoteId);
    const firstPayload = await tokenPayload(first.data.notificationToken, bindings);
    const secondPayload = await tokenPayload(second.data.notificationToken, bindings);
    assert.equal(firstPayload.notificationKey, secondPayload.notificationKey);
    const responses = await Promise.all([
      notify(first.data.notificationToken, bindings),
      notify(second.data.notificationToken, bindings)
    ]);
    assert.equal(responses.every(item => [200, 409].includes(item.response.status)), true);
    assert.equal(deliveries.length, 1);
  } finally {
    Date.now = realNow;
    restore();
  }
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
    parts[parts.length - 1] = `${parts.at(-1).startsWith('a') ? 'b' : 'a'}${parts.at(-1).slice(1)}`;
    const changed = parts.join('.');
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

test('brak wymaganego tokenu zwraca 400 z czytelnym błędem', async () => {
  const response = await notifyQuote({
    request: request('/api/quote-notification', {}),
    env: env()
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { sent: false, error: 'invalid-token' });
});

test('brak konfiguracji powiadomień zwraca 503 z czytelnym błędem', async () => {
  const response = await notifyQuote({
    request: request('/api/quote-notification', { token: 'dowolny' }),
    env: {}
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { sent: false, error: 'notification-not-configured' });
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

test('NOTIFICATION_DRY_RUN przechodzi pełną logikę bez próby wysyłki', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-dry-run/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Szafa dry-run', 1000) }, deliveries });
  try {
    const bindings = env({
      NOTIFICATION_DRY_RUN: '1',
      QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT: ''
    });
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-dry-run');
    const notification = await notify(result.data.notificationToken, bindings);
    assert.equal(notification.response.status, 200);
    assert.equal(notification.data.sent, false);
    assert.equal(notification.data.dryRun, true);
    assert.equal(notification.data.mode, 'notification-dry-run');
    assert.deepEqual(notification.data.fields, [
      '_subject',
      'typ_zdarzenia',
      'data_i_godzina',
      'identyfikator_wyceny',
      'produkty',
      'laczna_wartosc_produktow',
      'koszt_montazu',
      'uslugi_dodatkowe',
      'laczny_koszt_uslug_dodatkowych',
      'koszt_dojazdu',
      'laczna_orientacyjna_wycena',
      'miejscowosc',
      'odleglosc_od_gliwic_km',
      'rodzaj_mebla',
      'dodatkowe_informacje',
      'imie',
      'telefon',
      'email_klienta',
      'dane_techniczne'
    ]);
    assert.equal(deliveries.length, 0);
    assert.equal(await bindings.QUOTE_NOTIFICATION_KV.get(`notification:${result.data.quoteId}`), '1');
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

test('brak usług dodatkowych daje koszt 0 i wynik zgodny z backendem', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-no-extra-services/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Szafa', 1000) }, deliveries });
  try {
    const result = await calculate(body([{ url, quantity: 1 }], { extraServices: [] }), env(), 'test-no-extra-services');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data.quote.extraServices, []);
    assert.equal(result.data.quote.extraServicesTotal, 0);
    assert.equal(result.data.quote.total, result.data.quote.installation + result.data.quote.travel);
    const payload = await tokenPayload(result.data.notificationToken, env());
    assert.deepEqual(payload.quote.extraServices, []);
    assert.equal(payload.quote.extraServicesTotal, 0);
  } finally { restore(); }
});

test('jedna usługa dodatkowa jest liczona według tabeli backendu', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-one-extra-service/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Szafa', 1000) }, deliveries });
  try {
    const result = await calculate(body([{ url, quantity: 1 }], {
      extraServices: [{ serviceId: 'sink_cutout', quantity: 1 }]
    }), env(), 'test-one-extra-service');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data.quote.extraServices, [{
      serviceId: 'sink_cutout', name: 'Wycięcie otworu pod zlew', quantity: 1
    }]);
    assert.equal('unitPrice' in result.data.quote.extraServices[0], false);
    assert.equal('value' in result.data.quote.extraServices[0], false);
    assert.doesNotMatch(result.data.notificationToken, /sink_cutout|Wycięcie|unitPrice/);
    const signed = await tokenPayload(result.data.notificationToken, env());
    assert.equal(signed.quote.extraServices[0].unitPrice, 100);
    assert.equal(signed.quote.extraServices[0].value, 100);
    assert.equal(result.data.quote.extraServicesTotal, 100);
    assert.equal(result.data.quote.total, 300);
  } finally { restore(); }
});

test('kilka usług i ilość większa niż 1 sumują się po stronie backendu', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-many-extra-services/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Kuchnia testowa', 1000) }, deliveries });
  try {
    const result = await calculate(body([{ url, quantity: 1 }], {
      extraServices: [
        { serviceId: 'tap_install', quantity: 2 },
        { serviceId: 'dishwasher_connect', quantity: 1 },
        { serviceId: 'hood_install', quantity: 1 }
      ]
    }), env(), 'test-many-extra-services');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data.quote.extraServices.map(service => [service.serviceId, service.quantity]), [
      ['tap_install', 2],
      ['dishwasher_connect', 1],
      ['hood_install', 1]
    ]);
    const signed = await tokenPayload(result.data.notificationToken, env());
    assert.deepEqual(signed.quote.extraServices.map(service => [service.serviceId, service.quantity, service.unitPrice, service.value]), [
      ['tap_install', 2, 60, 120],
      ['dishwasher_connect', 1, 80, 80],
      ['hood_install', 1, 100, 100]
    ]);
    assert.equal(result.data.quote.extraServicesTotal, 300);
    assert.equal(result.data.quote.total, 500);
  } finally { restore(); }
});

test('wszystkie zatwierdzone serviceId mają właściwe stawki backendowe', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-all-extra-services/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Zestaw kuchenny', 2000) }, deliveries });
  try {
    const result = await calculate(body([{ url, quantity: 1 }], {
      extraServices: [
        { serviceId: 'sink_cutout', quantity: 1 },
        { serviceId: 'hob_cutout', quantity: 1 },
        { serviceId: 'sink_install', quantity: 1 },
        { serviceId: 'tap_install', quantity: 1 },
        { serviceId: 'dishwasher_connect', quantity: 1 },
        { serviceId: 'hood_install', quantity: 1 }
      ]
    }), env(), 'test-all-extra-services');
    assert.equal(result.response.status, 200);
    const signed = await tokenPayload(result.data.notificationToken, env());
    assert.deepEqual(Object.fromEntries(signed.quote.extraServices.map(service => [service.serviceId, service.unitPrice])), {
      sink_cutout: 100,
      hob_cutout: 100,
      sink_install: 100,
      tap_install: 60,
      dishwasher_connect: 80,
      hood_install: 100
    });
    assert.equal(result.data.quote.extraServicesTotal, 540);
    assert.equal(result.data.quote.total, 940);
  } finally { restore(); }
});

test('nieistniejący serviceId jest odrzucany przed pobraniem produktu', async () => {
  const deliveries = [];
  const restore = installFetchMock({ deliveries });
  try {
    const result = await calculate(body([{ url: 'https://www.ikea.com/pl/pl/p/test-unknown-service/', quantity: 1 }], {
      extraServices: [{ serviceId: 'wlasna-usluga', quantity: 1 }]
    }), env(), 'test-unknown-service');
    assert.equal(result.response.status, 400);
    assert.equal(result.data.error, 'Nieprawidłowe żądanie.');
    assert.equal(deliveries.length, 0);
  } finally { restore(); }
});

test('duplikat usługi i ilość spoza zakresu są odrzucane', async () => {
  const deliveries = [];
  const restore = installFetchMock({ deliveries });
  try {
    const url = 'https://www.ikea.com/pl/pl/p/test-invalid-extra-quantity/';
    const duplicate = await calculate(body([{ url, quantity: 1 }], {
      extraServices: [
        { serviceId: 'sink_install', quantity: 1 },
        { serviceId: 'sink_install', quantity: 1 }
      ]
    }), env(), 'test-duplicate-service');
    const tooMany = await calculate(body([{ url, quantity: 1 }], {
      extraServices: [{ serviceId: 'sink_install', quantity: 11 }]
    }), env(), 'test-extra-quantity');
    assert.equal(duplicate.response.status, 400);
    assert.equal(tooMany.response.status, 400);
    assert.equal(deliveries.length, 0);
  } finally { restore(); }
});

test('kwoty usług i sumy przesłane przez frontend nie wpływają na wycenę', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-price-injection/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Komoda', 800) }, deliveries });
  try {
    const result = await calculate(body([{ url, quantity: 1 }], {
      extraServices: [{ serviceId: 'sink_cutout', quantity: 1, unitPrice: 1, price: 1, value: 1 }],
      extraServicesTotal: 99_999,
      installation: 1,
      travel: 1,
      total: 1
    }), env(), 'test-price-injection');
    assert.equal(result.response.status, 200);
    assert.equal(result.data.quote.installation, 160);
    assert.equal('unitPrice' in result.data.quote.extraServices[0], false);
    assert.equal('value' in result.data.quote.extraServices[0], false);
    const signed = await tokenPayload(result.data.notificationToken, env());
    assert.equal(signed.quote.extraServices[0].unitPrice, 100);
    assert.equal(signed.quote.extraServices[0].value, 100);
    assert.equal(result.data.quote.extraServicesTotal, 100);
    assert.equal(result.data.quote.travel, 0);
    assert.equal(result.data.quote.total, 260);
  } finally { restore(); }
});

test('e-mail właściciela zawiera wszystkie usługi, ilości i wewnętrzne ceny', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-extra-services-email/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('Kuchnia', 1500) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }], {
      city: 'Zabrze', distance: 10,
      extraServices: [
        { serviceId: 'hob_cutout', quantity: 2 },
        { serviceId: 'dishwasher_connect', quantity: 1 }
      ]
    }), bindings, 'test-extra-services-email');
    const notification = await notify(result.data.notificationToken, bindings);
    assert.equal(notification.response.status, 200);
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0].uslugi_dodatkowe, /Wycięcie otworu pod płytę/);
    assert.match(deliveries[0].uslugi_dodatkowe, /Identyfikator: hob_cutout/);
    assert.match(deliveries[0].uslugi_dodatkowe, /Ilość: 2/);
    assert.match(deliveries[0].uslugi_dodatkowe, /Cena jednostkowa: 100 zł/);
    assert.match(deliveries[0].uslugi_dodatkowe, /Wartość pozycji: 200 zł/);
    assert.match(deliveries[0].uslugi_dodatkowe, /Podłączenie zmywarki/);
    assert.match(deliveries[0].uslugi_dodatkowe, /Cena jednostkowa: 80 zł/);
    assert.equal(deliveries[0].laczny_koszt_uslug_dodatkowych, '280 zł');
    assert.equal(deliveries[0].koszt_montazu, '300 zł');
    assert.equal(deliveries[0].koszt_dojazdu, '30 zł');
    assert.equal(deliveries[0].laczna_orientacyjna_wycena, '610 zł');
    assert.equal(deliveries[0].identyfikator_wyceny, result.data.quoteId);
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

test('skonfigurowany Telegram działa równolegle z Formspree', async () => {
  const deliveries = [];
  const telegramDeliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-telegram-parallel/';
  const restore = installFetchMock({
    products: { [url]: PRODUCT_HTML('Stolik', 400) },
    deliveries,
    telegramDeliveries
  });
  try {
    const bindings = env({
      QUOTE_NOTIFICATION_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
      QUOTE_NOTIFICATION_TELEGRAM_CHAT_ID: TELEGRAM_CHAT_ID
    });
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-telegram-parallel');
    const notification = await notify(result.data.notificationToken, bindings);
    assert.equal(notification.response.status, 200);
    assert.deepEqual(notification.data.channels, { formspree: 'sent', telegram: 'sent' });
    assert.equal(deliveries.length, 1);
    assert.equal(telegramDeliveries.length, 1);
    assert.equal(telegramDeliveries[0].chat_id, TELEGRAM_CHAT_ID);
    assert.match(telegramDeliveries[0].text, /Nowa wycena z kalkulatora Meblofix/);
    assert.match(telegramDeliveries[0].text, /Identyfikator produktu: ikea\.com\/pl\/pl\/p\/test-telegram-parallel\//);
    assert.doesNotMatch(telegramDeliveries[0].text, /https?:\/\//i);
    assert.deepEqual(telegramDeliveries[0].link_preview_options, { is_disabled: true });
  } finally { restore(); }
});

test('brak jednej zmiennej Telegram pozostawia kanał nieaktywny', async () => {
  const deliveries = [];
  const telegramDeliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-telegram-inactive/';
  const restore = installFetchMock({
    products: { [url]: PRODUCT_HTML('Półka', 300) },
    deliveries,
    telegramDeliveries
  });
  try {
    const bindings = env({ QUOTE_NOTIFICATION_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN });
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-telegram-inactive');
    const notification = await notify(result.data.notificationToken, bindings);
    assert.equal(notification.response.status, 200);
    assert.deepEqual(notification.data.channels, { formspree: 'sent', telegram: 'inactive' });
    assert.equal(deliveries.length, 1);
    assert.equal(telegramDeliveries.length, 0);
  } finally { restore(); }
});

test('Telegram podtrzymuje powiadomienie przy odrzuceniu przez Formspree', async () => {
  const deliveries = [];
  const telegramDeliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-telegram-fallback/';
  const restore = installFetchMock({
    products: { [url]: PRODUCT_HTML('Biurko', 500) },
    deliveries,
    deliveryStatus: 500,
    telegramDeliveries
  });
  try {
    const bindings = env({
      QUOTE_NOTIFICATION_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
      QUOTE_NOTIFICATION_TELEGRAM_CHAT_ID: TELEGRAM_CHAT_ID
    });
    const result = await calculate(body([{ url, quantity: 1 }]), bindings, 'test-telegram-fallback');
    const notification = await notify(result.data.notificationToken, bindings);
    assert.equal(notification.response.status, 200);
    assert.deepEqual(notification.data.channels, { formspree: 'failed', telegram: 'sent' });
    assert.equal(deliveries.length, 1);
    assert.equal(telegramDeliveries.length, 1);
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
  const serviceUi = html.slice(html.indexOf('<section class="quote-extra-services"'), html.indexOf('</section>', html.indexOf('<section class="quote-extra-services"')));
  assert.doesNotMatch(serviceUi, /\b(?:60|80|100)\s*zł|unitPrice|price|value/);
  assert.match(serviceUi, /sink_cutout/);
  assert.match(serviceUi, /hood_install/);
});

test('frontend i quote-products zachowują zgodny kontrakt payloadu kalkulatora', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const backend = await readFile(new URL('../functions/api/quote-products.js', import.meta.url), 'utf8');
  const start = html.indexOf('const requestData = {');
  const end = html.indexOf('\n    };', start);
  assert.ok(start >= 0 && end > start, 'brak payloadu requestData kalkulatora');
  const frontendPayload = html.slice(start, end);
  for (const pattern of [
    /\bitems\b/,
    /extraServices:\s*selectedExtraServices\(\)/,
    /city:\s*quoteCityField\.value\.trim\(\)/,
    /distance:\s*Number\(quoteDistanceField\.value\)/,
    /furnitureType:\s*quoteServiceField\.value/,
    /details:\s*quoteDetailsField\.value\.trim\(\)/,
    /contact:\s*\{\s*name:/
  ]) assert.match(frontendPayload, pattern);
  for (const pattern of [
    /body\?\.items/,
    /body\?\.extraServices/,
    /body\?\.city/,
    /body\?\.distance/,
    /body\?\.furnitureType/,
    /body\?\.details/,
    /body\?\.contact\?\.name/,
    /body\?\.contact\?\.phone/,
    /body\?\.contact\?\.email/
  ]) assert.match(backend, pattern);
});

test('CTA jest w polach kalkulatora przed kontaktem i awaria powiadomienia nie czyści wyniku', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const fieldsStart = html.indexOf('<fieldset class="quote-fields">');
  const fieldsEnd = html.indexOf('</fieldset>', fieldsStart);
  const calculateButton = html.indexOf('id="quoteCalculate"');
  const contact = html.indexOf('<fieldset class="quote-contact">');
  assert.ok(fieldsStart < calculateButton && calculateButton < fieldsEnd && fieldsEnd < contact);
  assert.match(html, /quoteCalculate\.disabled = true; quoteCalculate\.textContent = 'Analizuję linki…'/);
  assert.match(html, /quoteCalculate\.textContent = 'PRZELICZ WYCENĘ'/);
  const notificationFailure = html.slice(html.indexOf('async function sendCalculationNotice'), html.indexOf('function validateContact'));
  assert.doesNotMatch(notificationFailure, /setResult\(null\)|lastCalculation\s*=\s*null/);
  assert.match(notificationFailure, /console\.warn/);
  assert.match(html, /individualQuoteReady = true/);
  assert.match(html, /if \(!lastCalculation && !individualQuoteReady\)/);
  assert.match(html, /link\.href = '#quoteContact'/);
});

test('SSRF przez prywatny IPv6 i nieszyfrowany URL oficjalnego hosta są blokowane przed fetch', async () => {
  const deliveries = [];
  const requests = [];
  const restore = installFetchMock({ deliveries, requests });
  try {
    const privateIpv6 = await calculate(body([{ url: 'https://[::1]/produkt', quantity: 1 }]), env(), 'test-ssrf-ipv6');
    const insecureOfficial = await calculate(body([{ url: 'http://www.ikea.com/pl/pl/p/test-http/', quantity: 1 }]), env(), 'test-http-url');
    assert.equal(privateIpv6.response.status, 200);
    assert.equal(privateIpv6.data.allConfirmed, false);
    assert.equal(insecureOfficial.response.status, 200);
    assert.equal(insecureOfficial.data.allConfirmed, false);
    assert.equal(requests.length, 0);
  } finally { restore(); }
});

test('redirect do prywatnego IP i downgrade do HTTP są odrzucane', async () => {
  const deliveries = [];
  const requests = [];
  const privateRedirect = 'https://www.ikea.com/pl/pl/p/test-private-redirect/';
  const httpRedirect = 'https://www.ikea.com/pl/pl/p/test-http-redirect/';
  const restore = installFetchMock({
    products: {
      [privateRedirect]: { status: 302, headers: { location: 'https://127.0.0.1/metadata' } },
      [httpRedirect]: { status: 302, headers: { location: 'http://www.ikea.com/pl/pl/p/downgrade/' } }
    },
    deliveries,
    requests
  });
  try {
    const first = await calculate(body([{ url: privateRedirect, quantity: 1 }]), env(), 'test-private-redirect');
    const second = await calculate(body([{ url: httpRedirect, quantity: 1 }]), env(), 'test-http-redirect');
    assert.equal(first.data.allConfirmed, false);
    assert.equal(second.data.allConfirmed, false);
    assert.deepEqual(requests.map(item => item.url), [privateRedirect, httpRedirect]);
  } finally { restore(); }
});

test('body większe niż 32 KB jest odrzucane strumieniowo przez oba API', async () => {
  const oversized = JSON.stringify({ token: 'x'.repeat(33_000) });
  const productResponse = await calculateQuote({
    request: rawRequest('/api/quote-products', oversized),
    env: env()
  });
  const notificationResponse = await notifyQuote({
    request: rawRequest('/api/quote-notification', oversized),
    env: env()
  });
  assert.equal(productResponse.status, 413);
  assert.equal(notificationResponse.status, 413);
  assert.equal((await productResponse.json()).error, 'Żądanie jest zbyt duże.');
  assert.equal((await notificationResponse.json()).error, 'request-too-large');
});

test('więcej niż 10 produktów, duplikaty i skrajna ilość są odrzucane przed fetch', async () => {
  const deliveries = [];
  const requests = [];
  const restore = installFetchMock({ deliveries, requests });
  try {
    const eleven = Array.from({ length: 11 }, (_, index) => ({
      url: `https://www.ikea.com/pl/pl/p/test-limit-${index}/`,
      quantity: 1
    }));
    const duplicateUrl = 'https://www.ikea.com/pl/pl/p/test-duplicate/';
    const tooMany = await calculate(body(eleven), env(), 'test-items-limit');
    const duplicate = await calculate(body([
      { url: duplicateUrl, quantity: 1 },
      { url: duplicateUrl, quantity: 2 }
    ]), env(), 'test-items-duplicate');
    const extremeQuantity = await calculate(body([{ url: duplicateUrl, quantity: 101 }]), env(), 'test-items-quantity');
    assert.equal(tooMany.response.status, 400);
    assert.equal(duplicate.response.status, 400);
    assert.equal(extremeQuantity.response.status, 400);
    assert.equal(requests.length, 0);
  } finally { restore(); }
});

test('API wymaga application/json, nie udostępnia CORS i zwraca nagłówki bezpieczeństwa', async () => {
  const value = JSON.stringify(body([{ url: 'https://www.ikea.com/pl/pl/p/test-cors/', quantity: 1 }]));
  const productResponse = await calculateQuote({
    request: rawRequest('/api/quote-products', value, 'text/plain', 'https://attacker.example'),
    env: env()
  });
  const notificationResponse = await notifyQuote({
    request: rawRequest('/api/quote-notification', JSON.stringify({ token: 'x' }), 'text/plain', 'https://attacker.example'),
    env: env()
  });
  assert.equal(productResponse.status, 415);
  assert.equal(notificationResponse.status, 415);
  for (const response of [productResponse, notificationResponse]) {
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  }
});

test('wstrzyknięcia odbiorcy, endpointu, nagłówków, HTML i znaków bidi nie przechodzą do pól technicznych', async () => {
  const deliveries = [];
  const url = 'https://www.ikea.com/pl/pl/p/test-mail-injection/';
  const restore = installFetchMock({ products: { [url]: PRODUCT_HTML('<b>Szafa</b>\u202E', 1000) }, deliveries });
  try {
    const bindings = env();
    const result = await calculate(body([{ url, quantity: 1 }], {
      details: '<img src=x onerror=alert(1)>\r\nBcc: attacker@example.com',
      contact: {
        name: 'Anna\r\nBcc: attacker@example.com',
        phone: '500 000 000',
        email: 'anna@example.com\r\nReply-To: attacker@example.com'
      }
    }), bindings, 'test-mail-injection');
    const notification = await notify(result.data.notificationToken, bindings, {
      endpoint: 'https://attacker.example/collect',
      recipient: 'attacker@example.com',
      _subject: 'Podmieniony temat',
      _replyto: 'attacker@example.com'
    });
    assert.equal(notification.response.status, 200);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]._subject, 'Nowa wycena z kalkulatora Meblofix');
    assert.equal(deliveries[0].recipient, undefined);
    assert.equal(deliveries[0].endpoint, undefined);
    assert.equal(deliveries[0]._replyto, undefined);
    assert.doesNotMatch(deliveries[0].produkty, /[<>\u202E]/);
    assert.doesNotMatch(deliveries[0].dodatkowe_informacje, /[<>]/);
    assert.match(deliveries[0].imie, /Bcc: attacker@example\.com/);
  } finally { restore(); }
});

test('limity wejściowe zatrzymują burst przed kosztownym przetwarzaniem', async () => {
  const productBindings = env();
  const productStatuses = [];
  for (let index = 0; index < 16; index += 1) {
    const response = await calculateQuote({
      request: rawRequest('/api/quote-products', '{}'),
      env: productBindings
    });
    productStatuses.push(response.status);
  }
  assert.deepEqual(productStatuses.slice(0, 15), Array(15).fill(400));
  assert.equal(productStatuses[15], 429);

  const notificationBindings = env();
  const notificationStatuses = [];
  for (let index = 0; index < 21; index += 1) {
    notificationStatuses.push((await notify(`invalid-${index}`, notificationBindings)).response.status);
  }
  assert.deepEqual(notificationStatuses.slice(0, 20), Array(20).fill(400));
  assert.equal(notificationStatuses[20], 429);
});
