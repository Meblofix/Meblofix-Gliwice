import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

await import('../js/quote-distance.js');
const distance = globalThis.MeblofixQuoteDistance;
const config = JSON.parse(await readFile(new URL('../data/cennik.json', import.meta.url), 'utf8'));

test('Gliwice ukrywają pole i zawsze normalizują pustą odległość do 0', () => {
  const state = distance.deriveDistanceState({
    city: '  GLIWICE ',
    currentValue: '',
    suggestions: config.serviceArea.cities
  });
  assert.equal(state.hidden, true);
  assert.equal(state.required, false);
  assert.equal(state.value, '0');
  assert.deepEqual(distance.validateDistance({
    city: 'Gliwice',
    value: '',
    maximumDistance: config.serviceArea.maximumDistanceOneWayKilometers
  }), { valid: true, distance: 0 });
});

test('potwierdzona podpowiedź wypełnia pole, które nadal przyjmuje ręczną zmianę', () => {
  const suggestions = [{ name: 'Zabrze', distanceOneWayKilometers: 11 }];
  const suggested = distance.deriveDistanceState({
    city: 'Zabrze',
    previousCityKey: '',
    currentValue: '',
    suggestions
  });
  assert.equal(suggested.hidden, false);
  assert.equal(suggested.required, true);
  assert.equal(suggested.value, '11');

  const manuallyChanged = distance.deriveDistanceState({
    city: 'Zabrze',
    previousCityKey: suggested.cityKey,
    currentValue: '14',
    suggestions
  });
  assert.equal(manuallyChanged.cityChanged, false);
  assert.equal(manuallyChanged.value, '14');
});

test('miasto bez podpowiedzi zostawia puste pole i tworzy bezpieczny link Google Maps', () => {
  const state = distance.deriveDistanceState({
    city: 'Kędzierzyn-Koźle',
    previousCityKey: 'gliwice',
    currentValue: '0',
    suggestions: config.serviceArea.cities
  });
  assert.equal(state.hidden, false);
  assert.equal(state.value, '');
  assert.equal(state.mapsUrl, 'https://www.google.com/maps/dir/Gliwice/K%C4%99dzierzyn-Ko%C5%BAle');
  assert.equal(distance.mapsDirectionsUrl(''), 'https://www.google.com/maps/dir/Gliwice');
});

test('walidacja wymaga całkowitej odległości w deklarowanym obszarze', () => {
  const maximumDistance = config.serviceArea.maximumDistanceOneWayKilometers;
  assert.match(distance.validateDistance({ city: 'Zabrze', value: '', maximumDistance }).message, /jedną stronę/);
  assert.match(distance.validateDistance({ city: 'Zabrze', value: '10.5', maximumDistance }).message, /całkowitą/);
  assert.match(distance.validateDistance({ city: 'Zabrze', value: '0', maximumDistance }).message, /co najmniej 1 km/);
  assert.match(distance.validateDistance({ city: 'Zabrze', value: '41', maximumDistance }).message, /40 km/);
  assert.deepEqual(distance.validateDistance({ city: 'Zabrze', value: '12', maximumDistance }), { valid: true, distance: 12 });
});

test('config zawiera tylko repozytoryjne miejscowości i nie przypisuje niepotwierdzonych kilometrów', () => {
  const expectedCities = [
    'Gliwice', 'Zabrze', 'Bytom', 'Katowice', 'Rybnik', 'Tychy', 'Chorzów', 'Mikołów',
    'Knurów', 'Pyskowice', 'Gierałtowice', 'Rudziniec', 'Pogrzebień',
    'Kędzierzyn-Koźle', 'Jastrzębie-Zdrój'
  ];
  assert.deepEqual(config.serviceArea.cities.map(city => city.name), expectedCities);
  assert.deepEqual(
    config.serviceArea.cities.filter(city => city.distanceOneWayKilometers !== null),
    [{ name: 'Gliwice', distanceOneWayKilometers: 0 }]
  );
});

test('interfejs korzysta z modułu, wspólnego configu i nie hardkoduje reguły dojazdu', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="js\/quote-distance\.js"><\/script>/);
  assert.match(html, /id="quoteDistanceFieldWrap" hidden/);
  assert.match(html, /\[\[SERVICE_AREA_CITY_OPTIONS\]\]/);
  assert.match(html, /\[\[SERVICE_AREA_MAX_DISTANCE\]\]/);
  assert.match(html, /id="quoteTravelRule">\[\[TRAVEL_RULE\]\]/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html.slice(html.indexOf('id="quoteDistanceFieldWrap"'), html.indexOf('id="quoteDetails"')), /1[.,]50 zł|×\s*2/);
});
