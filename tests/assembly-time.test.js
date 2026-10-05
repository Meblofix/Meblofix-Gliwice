import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { productKey, parseAssemblyDuration, resolveManufacturerTime, assemblyForProduct, calculateAssemblyQuote } from '../functions/api/assembly-time.js';
import { onRequestPost, verifyQuoteToken } from '../functions/api/quote-products.js';
import { automaticNotificationFields } from '../functions/api/quote-notification.js';
import config from '../data/cennik.json' with { type: 'json' };
import catalog from '../data/assembly-times.json' with { type: 'json' };

// Wszystkie produkty i deklaracje w tym pliku są syntetycznymi fixture'ami.
// Nie dowodzą publikowania czasu przez żaden rzeczywisty model.
const url = 'https://www.ikea.com/pl/pl/p/fixture-szafa-12345678/';
const now = Date.parse('2026-10-05T12:00:00Z');
const context = { furnitureType: 'Meble z paczek' };
const item = (overrides = {}) => ({ '@type': 'Product', name: 'Szafa fixture', url, sku: '12345678', brand: { name: 'IKEA' },
  offers: { price: 1000, priceCurrency: 'PLN' }, additionalProperty: [
    { name: 'Czas montażu', value: '2 h' }, { name: 'Liczba osób do montażu', value: 2 }
  ], ...overrides });
const product = (overrides = {}) => ({ name: 'Szafa fixture', url, quantity: 1, price: 1000, ...overrides });
function assembled(overrides = {}, structured = item()) {
  const p = product(overrides);
  p.manufacturerAssembly = resolveManufacturerTime(p, structured, p.url, { now });
  p.assembly = assemblyForProduct(p, context);
  return p;
}

for (const [value, unit, expected] of [
  ['90 min', '', [90, 90]], ['1,5 h', '', [90, 90]], ['1 h 30 min', '', [90, 90]],
  ['2–3 godz.', '', [120, 180]], ['PT1H30M', '', [90, 90]], [90, 'MMT', [90, 90]], ['2', 'HUR', [120, 120]]
]) test(`jednostki czasu: ${value} ${unit}`, () => {
  const result = parseAssemblyDuration(value, unit);
  assert.deepEqual([result.minutesMin, result.minutesMax], expected);
});
for (const value of ['90', '0 min', '-2 h', '3-2 h', '2 dni', '25 h', 'około godziny', '2 h dostawa 3 h', 'PT']) {
  test(`niejednoznaczny lub nieprawidłowy czas: ${value}`, () => assert.equal(parseAssemblyDuration(value), null));
}

test('oficjalny Product przypisany do dokładnego URL ma źródło, datę i skład ekipy', () => {
  const result = assembled({ quantity: 3 });
  assert.equal(result.assembly.manufacturer.status, 'confirmed');
  assert.equal(result.assembly.manufacturer.source.url, url);
  assert.equal(result.assembly.manufacturer.source.checkedAt, new Date(now).toISOString());
  assert.equal(result.assembly.manufacturer.productId, '12345678');
  assert.deepEqual(result.assembly.manufacturerTotal, { minutesMin: 360, minutesMax: 360, people: 2 });
  assert.equal(result.assembly.working.totalMinutesMin, 405);
  assert.equal(result.assembly.working.totalMinutesMax, 495);
});

test('wariant, offerId i SKU produktu nie są zastępowane podobną nazwą', () => {
  assert.notEqual(productKey(url + '?variant=white'), productKey(url + '?variant=black'));
  assert.notEqual(productKey('https://allegro.pl/oferta/fixture-12345678?offerId=12345678'), productKey('https://allegro.pl/oferta/fixture-12345678?offerId=87654321'));
  assert.equal(productKey(url + '?utm_source=test'), productKey(url));
  assert.equal(resolveManufacturerTime(product(), item({ url: url.replace('12345678', '87654321') }), url, { now }).status, 'unavailable');
});

test('Agata i Allegro nie stają się źródłem producenta przez brand lub tekst sprzedawcy', () => {
  for (const retailUrl of ['https://www.agatameble.pl/fixture', 'https://allegro.pl/oferta/fixture-12345678']) {
    assert.equal(resolveManufacturerTime(product({ url: retailUrl }), item({ url: retailUrl }), retailUrl, { now }).status, 'unavailable');
  }
  assert.equal(resolveManufacturerTime(product(), item({ brand: { name: 'Inny producent' } }), url, { now }).status, 'unavailable');
});

test('sprzeczne czasy, brak jednostki i sprzeczne liczby osób nie są potwierdzane', () => {
  for (const props of [
    [{ name: 'Czas montażu', value: '2 h' }, { name: 'Czas montażu', value: '3 h' }],
    [{ name: 'Czas montażu', value: 90 }],
    [{ name: 'Czas montażu', value: '2 h' }, { name: 'Assembly people', value: 1 }, { name: 'Assembly people', value: 2 }]
  ]) assert.equal(resolveManufacturerTime(product(), item({ additionalProperty: props }), url, { now }).status, 'unavailable');
});

test('brak liczby osób zachowuje czas producenta i osobno oznacza szacunek kategorii', () => {
  const p = assembled({}, item({ additionalProperty: [{ name: 'Czas montażu', value: '2 h' }] }));
  assert.equal(p.assembly.manufacturer.status, 'confirmed');
  assert.equal(p.assembly.manufacturer.people, null);
  assert.equal(p.assembly.manufacturerTotal.minutesMin, 120);
  assert.equal(p.assembly.working.basis, 'category_estimate');
  assert.equal(p.assembly.working.minutesMin, 180);
});

test('deklaracja producenta wymagająca większej ekipy zachowuje czas i wymusza ręczną wycenę', () => {
  const p = assembled({}, item({ additionalProperty: [{ name: 'Czas montażu', value: '2 h' }, { name: 'Assembly people', value: 4 }] }));
  assert.equal(p.assembly.manufacturer.status, 'confirmed');
  assert.equal(p.assembly.manufacturer.people, 4);
  assert.equal(p.assembly.working, null);
  assert.equal(calculateAssemblyQuote([p], context).requiresManualQuote, true);
});

const entry = { productUrl: url, productId: '12345678', model: 'Szafa fixture', manufacturer: 'IKEA',
  sourceUrl: 'https://www.ikea.com/pl/pl/fixture-instruction.pdf', verifiedAt: '2026-10-04T12:00:00Z',
  evidence: 'Fixture instrukcji: 120 min, 2 osoby', minutesMin: 120, minutesMax: 120, people: 2 };
const reviewed = entries => ({ ...catalog, products: entries });
test('zweryfikowany katalog wiąże dokładny produkt z oficjalną instrukcją', () => {
  const result = resolveManufacturerTime(product(), null, url, { catalog: reviewed([entry]), now });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.source.kind, 'reviewed_instruction');
  assert.equal(result.source.url, entry.sourceUrl);
});
test('katalog odrzuca stary wpis, przyszłą datę, brak dowodu, sprzedawcę i duplikaty', () => {
  for (const invalid of [
    { ...entry, verifiedAt: '2025-01-01' }, { ...entry, verifiedAt: '2027-01-01' },
    { ...entry, evidence: '' }, { ...entry, sourceUrl: 'https://allegro.pl/fixture.pdf' }, { ...entry, people: 0 }
  ]) assert.equal(resolveManufacturerTime(product(), null, url, { catalog: reviewed([invalid]), now }).status, 'unavailable');
  assert.equal(resolveManufacturerTime(product(), null, url, { catalog: reviewed([entry, entry]), now }).status, 'unavailable');
  assert.equal(resolveManufacturerTime(product(), null, url + '?variant=other', { catalog: reviewed([entry]), now }).status, 'unavailable');
});

test('wpis katalogu nie zastępuje innego SKU odczytanego z aktualnej strony', () => {
  assert.equal(resolveManufacturerTime(product(), item({ sku: '87654321' }), url, { catalog: reviewed([entry]), now }).status, 'unavailable');
});

test('wpis katalogu wymaga zgodności modelu, URL i producenta z bieżącym produktem', () => {
  for (const [currentProduct, structured] of [
    [product({ name: 'Inna szafa' }), null],
    [product(), item({ url: url.replace('12345678', '87654321') })],
    [product(), item({ brand: { name: 'JYSK' } })]
  ]) {
    assert.equal(resolveManufacturerTime(currentProduct, structured, url, { catalog: reviewed([entry]), now }).status, 'unavailable');
  }
});

test('katalog odrzuca obcą, nierozpoznaną i sprzeczną deklarację producenta', () => {
  for (const fields of [
    { brand: 'Inny producent' },
    { manufacturer: 'Inny producent', brand: 'IKEA' },
    { manufacturer: 'IKEA', brand: 'JYSK' },
    { manufacturer: 'IKEA', brand: 'Inny producent' }
  ]) {
    const structured = item({ manufacturer: undefined, brand: undefined, ...fields });
    const result = resolveManufacturerTime(product(), structured, url, { catalog: reviewed([entry]), now });
    assert.equal(result.status, 'unavailable', JSON.stringify(fields));
    assert.equal(result.reason, 'conflicting_manufacturer', JSON.stringify(fields));
    assert.equal(assemblyForProduct({ ...product(), manufacturerAssembly: result }, context).working, null);
  }
});

test('katalog pozostaje dostępny, gdy strona nie deklaruje producenta ani marki', () => {
  const structured = item({ manufacturer: undefined, brand: undefined });
  const result = resolveManufacturerTime(product(), structured, url, { catalog: reviewed([entry]), now });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.source.kind, 'reviewed_instruction');
});

test('sprzeczne dane producenta i marki nie potwierdzają czasu z samego JSON-LD', () => {
  const result = resolveManufacturerTime(product(), item({ manufacturer: 'IKEA', brand: 'JYSK' }), url, { now });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'conflicting_manufacturer');
});

test('wpis katalogu wymaga poprawnej daty weryfikacji w UTC i prawidłowego URL produktu', () => {
  for (const verifiedAt of ['2026-10-04', '2026-10-04T12:00:00+02:00', '2026-02-30T12:00:00Z']) {
    assert.equal(resolveManufacturerTime(product(), null, url, { catalog: reviewed([{ ...entry, verifiedAt }]), now }).status, 'unavailable');
  }
  assert.equal(resolveManufacturerTime(product({ url: 'invalid' }), null, 'invalid', { catalog: reviewed([{ ...entry, productUrl: 'invalid' }]), now }).status, 'unavailable');
});

test('pięć sztuk ma pełną sumę i nie jest liczone jako cztery', () => {
  const result = calculateAssemblyQuote([assembled({ quantity: 5 })], context);
  assert.deepEqual(result.manufacturer, { complete: true, confirmedUnits: 5, totalUnits: 5, minutesMin: 600, minutesMax: 600 });
  assert.equal(result.working.minutesMin, 690); // 5 × (120 + 15) + 15
  assert.equal(result.working.minutesMax, 840); // 5 × (150 + 15) + 15
  assert.equal(result.working.people, 2);
  assert.equal(result.installationMin, 2070); // 690 / 60 × 180
  assert.equal(result.installationMax, 2520);
});

test('cena produktu nie zmienia czasu ani kosztu robocizny', () => {
  const cheap = calculateAssemblyQuote([assembled({ price: 50 })], context);
  const expensive = calculateAssemblyQuote([assembled({ price: 50000 })], context);
  assert.deepEqual(cheap, expensive);
  assert.equal(cheap.installationMin, 450);
  assert.equal(cheap.installationMax, 540);
});

test('brak producenta daje jawny szacunek kategorii, brak pełnych danych nigdy nie staje się pełną sumą', () => {
  const unknown = assembled({ name: 'Komoda fixture' }, null);
  assert.equal(unknown.assembly.manufacturer.status, 'unavailable');
  assert.equal(unknown.assembly.manufacturerTotal, null);
  assert.equal(unknown.assembly.working.basis, 'category_estimate');
  const result = calculateAssemblyQuote([assembled(), unknown], context);
  assert.equal(result.manufacturer.complete, false);
  assert.equal(result.manufacturer.confirmedUnits, 1);
  assert.equal(result.manufacturer.totalUnits, 2);
  assert.equal(result.manufacturer.minutesMin, 120);
  assert.equal(result.working.basis, 'includes_category_estimate');
});

test('kategorie uwzględniają polskie znaki i szczególny przypadek stolika nocnego', () => {
  for (const [name, category, min] of [['Stół fixture', 'table', 30], ['Stolik nocny fixture', 'nightstand', 30]]) {
    const p = assembled({ name }, null);
    assert.equal(p.assembly.working.category, category);
    assert.equal(p.assembly.working.minutesMin, min);
  }
  assert.equal(assembled({ name: 'Stolik nocny i łóżko fixture' }, null).assembly.working, null);
});

test('nieznany produkt, kuchnia, zestaw i złożony wariant prowadzą do ręcznej wyceny bez fikcyjnego czasu i kwoty', () => {
  for (const name of ['Produkt fixture', 'Kuchnia fixture', 'Zestaw mebli fixture', 'Szafa przesuwna fixture', 'Szafa narożna fixture', 'PAX szafa fixture']) {
    const result = calculateAssemblyQuote([assembled({ name }, null)], context);
    assert.equal(result.requiresManualQuote, true);
    assert.equal(result.working, null);
    assert.equal(result.installation, null);
  }
  assert.equal(calculateAssemblyQuote([assembled()], { furnitureType: 'Zestaw mebli' }).requiresManualQuote, true);
});

test('minimum stosowane jest do całej robocizny, po przemnożeniu wszystkich sztuk', () => {
  const p = assembled({ name: 'Krzesło fixture' }, null);
  const result = calculateAssemblyQuote([p], context);
  assert.equal(result.installationMin, config.publicRates.minimumJob);
  assert.equal(result.installationMax, config.publicRates.minimumJob);
  const four = calculateAssemblyQuote([assembled({ name: 'Krzesło fixture', quantity: 4 }, null)], context);
  assert.equal(four.installationMin, 158.33);
  assert.equal(four.installationMax, 325);
});

async function calculateWithPages(pages, quantities, extra = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const page = pages[String(input)];
    if (!page) throw Error('Brak fixture');
    return new Response(page, { headers: { 'content-type': 'text/html' } });
  };
  try {
    const response = await onRequestPost({ env: { QUOTE_NOTIFICATION_SECRET: 'assembly-test-secret-at-least-32-characters' }, request: new Request('https://meblofix-gliwice.pl/api/quote-products', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        items: Object.keys(pages).map((url, i) => ({ url, quantity: quantities[i], manufacturerAssembly: { minutesMin: 1, people: 1 } })),
        city: 'Zabrze', distance: 10, furnitureType: 'Meble z paczek', contact: {}, ...extra
      })
    }) });
    assert.equal(response.status, 200);
    return await response.json();
  } finally { globalThis.fetch = original; }
}
const html = items => `<script type="application/ld+json">${JSON.stringify(items)}</script>`;
test('API podpisuje czasy i widełki, ignoruje czas od klienta, sumuje dojazd i dodatki', async () => {
  const result = await calculateWithPages({ [url]: html(item()) }, [3], { extraServices: [{ serviceId: 'sink_cutout', quantity: 2 }] });
  assert.equal(result.quote.manufacturer.minutesMin, 360);
  assert.equal(result.quote.working.minutesMin, 420);
  assert.equal(result.quote.working.minutesMax, 510);
  assert.equal(result.quote.installationMin, 1260);
  assert.equal(result.quote.installationMax, 1530);
  assert.equal(result.quote.totalMin, 1490);
  assert.equal(result.quote.totalMax, 1760);
  const signed = await verifyQuoteToken(result.notificationToken, { QUOTE_NOTIFICATION_SECRET: 'assembly-test-secret-at-least-32-characters' });
  assert.deepEqual(signed.quote.manufacturer, result.quote.manufacturer);
  assert.deepEqual(signed.quote.products[0].assembly, result.products[0].assembly);
  const fields = automaticNotificationFields(signed);
  assert.match(fields.get('produkty'), /Czas producenta \/ szt.: 120 min/);
  assert.match(fields.get('czas_roboczy'), /420–510 min; ekipa: 2/);
  assert.equal(fields.get('koszt_montazu'), '1260 zł–1530 zł');
  assert.doesNotMatch(fields.get('dane_techniczne'), /20%/);
});

test('API nie bierze czasu ani ceny z rekomendowanego Product przed właściwym produktem', async () => {
  const result = await calculateWithPages({ [url]: html([item({ name: 'Inna szafa', url: url.replace('12345678', '87654321'), offers: { price: 50000, priceCurrency: 'PLN' } }), item()]) }, [1]);
  assert.equal(result.products[0].price, 1000);
  assert.equal(result.products[0].assembly.manufacturer.status, 'confirmed');
});

test('sprzeczne bloki Product nie potwierdzają czasu producenta', async () => {
  const result = await calculateWithPages({ [url]: html([item(), item({ additionalProperty: [{ name: 'Czas montażu', value: '3 h' }] })]) }, [1]);
  assert.equal(result.products[0].assembly.manufacturer.status, 'unavailable');
  assert.equal(result.products[0].assembly.working, null);
  assert.equal(result.quote.requiresManualQuote, true);
});

test('API ręcznej wyceny pokazuje znany czas częściowy i nie wycenia niepełnego zlecenia', async () => {
  const other = 'https://www.ikea.com/pl/pl/p/fixture-inny-87654321/';
  const result = await calculateWithPages({ [url]: html(item()), [other]: html(item({ url: other, name: 'Nieznana bryła', additionalProperty: [] })) }, [1, 1]);
  assert.equal(result.allConfirmed, true);
  assert.equal(result.quote.requiresManualQuote, true);
  assert.equal(result.quote.manufacturer.complete, false);
  assert.equal(result.quote.manufacturer.minutesMin, 120);
  assert.equal(result.quote.total, null);
  assert.equal(result.quote.totalMin, null);
  assert.equal(result.quote.totalMax, null);
});

test('publiczny katalog i reguły szacunku nie zawierają procentu ceny i mają poprawne jednostki', () => {
  assert.equal('installationRate' in config.calculator, false);
  for (const profile of Object.values(config.calculator.assembly.fallbackProfiles)) {
    assert.ok(Number.isFinite(profile.minutesMin) && profile.minutesMin > 0);
    assert.ok(profile.minutesMax >= profile.minutesMin);
    assert.ok([1, 2].includes(profile.people));
  }
  assert.equal(catalog.schemaVersion, 1);
  for (const entry of catalog.products) {
    const resolved = resolveManufacturerTime(product({ url: entry.productUrl }), null, entry.productUrl);
    assert.equal(resolved.status, 'confirmed', `Niezweryfikowany wpis: ${entry.productId}`);
  }
});

test('renderer pokazuje źródło, ilości, sumę częściową, szacunek i brak kwoty przy ręcznej wycenie', async () => {
  class Element {
    constructor() { this.textContent = ''; this.children = []; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
  }
  const names = ['quoteManufacturerTime', 'quoteWorkingTime', 'quoteWorkCost', 'quoteExtraServicesCost', 'quoteTravelCost', 'quoteTotalCost', 'quoteTimeExplanation', 'quoteProductResults', 'quoteTravelExplanation'];
  const bindings = Object.fromEntries(names.map(name => [name, new Element()]));
  const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const renderer = htmlSource.slice(htmlSource.indexOf('  function timeRange('), htmlSource.indexOf('  function showIndividualQuote('));
  const sandbox = vm.createContext({ ...bindings, Intl, Date, Number, money: value => `${value} zł`, document: { createElement: () => new Element() } });
  vm.runInContext(renderer, sandbox);
  const p = assembled({ quantity: 2 });
  const data = { ...calculateAssemblyQuote([p], context), products: [p], travel: 0, totalMin: 855, totalMax: 1035 };
  sandbox.setResult(data);
  assert.match(bindings.quoteWorkingTime.textContent, /2 monterów/);
  assert.match(bindings.quoteProductResults.children[0].children[1].textContent, /Wszystkie 2 szt.: 4 h/);
  assert.equal(bindings.quoteProductResults.children[0].children[2].href, url);
  const manual = { ...data, requiresManualQuote: true, working: null, totalMin: null, totalMax: null, installationMin: null, installationMax: null, manufacturer: { ...data.manufacturer, complete: false, totalUnits: 3 } };
  sandbox.setResult(manual);
  assert.match(bindings.quoteManufacturerTime.textContent, /częściowa: 2\/3/);
  assert.equal(bindings.quoteTotalCost.textContent, 'Wycena ręczna');
  const single = assembled({ name: 'Krzesło fixture' }, null);
  sandbox.setResult({ ...calculateAssemblyQuote([single], context), products: [single], travel: 0, extraServicesTotal: 0,
    totalMin: 150, totalMax: 150 });
  assert.match(bindings.quoteWorkingTime.textContent, /1 monter$/);
  sandbox.setResult(null);
  assert.equal(bindings.quoteWorkingTime.textContent, '—');
  assert.equal(bindings.quoteProductResults.children.length, 0);
});
