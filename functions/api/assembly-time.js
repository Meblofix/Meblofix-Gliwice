import pricingConfig from '../../data/cennik.json' with { type: 'json' };
import timeCatalog from '../../data/assembly-times.json' with { type: 'json' };

// Dane sklepu/klienta i podobieństwo nazwy nie są dowodem czasu producenta.
const unavailable = reason => ({ status: 'unavailable', reason, minutesMin: null, minutesMax: null, people: null, source: null });
const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100;

export function productKey(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    url.hostname = url.hostname.replace(/^www\./, '');
    url.hash = '';
    // Parametry wariantu/offerId pozostają częścią klucza.
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}

export function parseAssemblyDuration(value, unit = '') {
  const text = String(value ?? '').trim().toLowerCase().replace(/,/g, '.').replace(/[–—]/g, '-');
  const units = String(unit).trim().toLowerCase();
  const multiplier = /^(min|minute|minutes|minuty|minut|m|mmt)$/.test(units) ? 1 : /^(h|hour|hours|godz|godziny|godzin|hur)$/.test(units) ? 60 : null;
  let min, max;
  const iso = text.match(/^pt(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/);
  const mixed = text.match(/^(\d+(?:\.\d+)?)\s*(?:h|godz\.?|godziny|hours?)\s+(\d+(?:\.\d+)?)\s*(?:min\.?|minut|minuty|minutes?)$/);
  const range = text.match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*(min\.?|minut|minuty|minutes?|h|godz\.?|godziny|godzin|hours?)?$/);
  if (iso && (iso[1] || iso[2])) min = max = Number(iso[1] || 0) * 60 + Number(iso[2] || 0);
  else if (mixed) min = max = Number(mixed[1]) * 60 + Number(mixed[2]);
  else if (range) {
    const factor = range[3] ? (/^(h|godz|hour)/.test(range[3]) ? 60 : 1) : multiplier;
    if (!factor) return null;
    min = Number(range[1]) * factor; max = Number(range[2] || range[1]) * factor;
  } else return null;
  if (![min, max].every(Number.isFinite) || min <= 0 || max < min || max > 1440) return null;
  return { minutesMin: Math.ceil(min), minutesMax: Math.ceil(max) };
}

function officialSource(value, manufacturer, catalog) {
  try {
    const url = new URL(value);
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) && !/\.(localhost|local|internal)$/i.test(url.hostname) && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && catalog.manufacturers[manufacturer]?.includes(url.hostname.toLowerCase());
  } catch { return false; }
}

function manufacturerName(item) {
  const value = item?.manufacturer?.name || (typeof item?.manufacturer === 'string' ? item.manufacturer : '')
    || item?.brand?.name || (typeof item?.brand === 'string' ? item.brand : '');
  const normalized = String(value).trim().toLowerCase();
  return ({ ikea: 'IKEA', jysk: 'JYSK', brw: 'Black Red White', 'black red white': 'Black Red White' })[normalized] || null;
}

export function resolveManufacturerTime(product, structuredProduct, finalUrl, { catalog = timeCatalog, now = Date.now() } = {}) {
  if (structuredProduct?.assemblyConflict) return unavailable('conflicting_product_data');
  const key = productKey(product.url);
  const entries = catalog.products.filter(entry => productKey(entry.productUrl) === key);
  if (entries.length > 1) return unavailable('conflicting_catalog');
  if (entries.length === 1) {
    const entry = entries[0];
    const verifiedAt = Date.parse(entry.verifiedAt);
    const age = now - verifiedAt;
    const duration = parseAssemblyDuration(`${entry.minutesMin}-${entry.minutesMax}`, 'min');
    if (productKey(finalUrl) !== key || (structuredProduct?.sku && String(structuredProduct.sku).replace(/[.\s]/g, '') !== String(entry.productId).replace(/[.\s]/g, '')) || !duration || !entry.productId || !entry.model || !entry.evidence
      || !officialSource(entry.sourceUrl, entry.manufacturer, catalog)
      || !Number.isFinite(verifiedAt) || age < 0 || age > pricingConfig.calculator.assembly.catalogMaxAgeDays * 86400000
      || !(entry.people === null || Number.isInteger(entry.people) && entry.people >= 1 && entry.people <= 10)) return unavailable('unverified_catalog');
    return { status: 'confirmed', ...duration, people: entry.people, manufacturer: entry.manufacturer,
      productId: entry.productId, model: entry.model,
      source: { url: entry.sourceUrl, kind: 'reviewed_instruction', checkedAt: entry.verifiedAt, evidence: entry.evidence } };
  }
  const item = structuredProduct;
  const manufacturer = manufacturerName(item);
  // Wybrany Product musi być przypisany do końcowego URL. Nie używamy opinii,
  // rekomendowanych produktów ani globalnego tekstu HTML.
  if (!item || !manufacturer || !officialSource(finalUrl, manufacturer, catalog)
    || productKey(item.url) !== productKey(finalUrl) || String(item.name) !== product.name) return unavailable('no_verified_source');
  const properties = Array.isArray(item.additionalProperty) ? item.additionalProperty : [item.additionalProperty];
  const times = properties.filter(property => /^(czas montażu|czas montazu|assembly time)$/i.test(String(property?.name || '').trim()));
  if (!times.length) return unavailable('not_published_in_supported_data');
  const durations = times.map(property => parseAssemblyDuration(property.value, property.unitCode || property.unitText));
  if (durations.some(value => !value) || new Set(durations.map(value => JSON.stringify(value))).size !== 1) return unavailable('ambiguous_duration');
  const peopleValues = properties.filter(property => /^(liczba osób do montażu|liczba osob do montazu|assembly people)$/i.test(String(property?.name || '').trim())).map(property => Number(property.value));
  if (peopleValues.some(value => !Number.isInteger(value) || value < 1 || value > 10) || new Set(peopleValues).size > 1) return unavailable('ambiguous_people');
  return { status: 'confirmed', ...durations[0], people: peopleValues[0] ?? null, manufacturer,
    productId: String(item.sku || item.productID || item.url), model: product.name,
    source: { url: String(finalUrl), kind: 'official_product_data', checkedAt: new Date(now).toISOString(),
      evidence: times.map(property => `${property.name}: ${property.value} ${property.unitText || property.unitCode || ''}`.trim()).join('; ') } };
}

function fallbackProfile(product, context) {
  const name = product.name.toLocaleLowerCase('pl-PL');
  if (context.furnitureType !== 'Meble z paczek' || /kuchni|zestaw|komplet|naroż|naroz|przesuwn|moduł|modul|pax|metod/.test(name)) return null;
  const patterns = [
    ['nightstand', /szafka nocna|stolik nocny/], ['wardrobe', /\bszafa\b/],
    ['bed', /łóżko|lozko|leżanka|lezanka/], ['chest', /komoda/],
    ['shelf', /regał|regal/], ['desk', /biurko/], ['table', /(?:^|[^\p{L}])(?:stół|stol)(?:$|[^\p{L}])|stolik/u], ['chair', /krzesło|krzeslo/]
  ];
  let matches = patterns.filter(([, pattern]) => pattern.test(name));
  if (matches.some(([category]) => category === 'nightstand')) matches = matches.filter(([category]) => category !== 'table');
  if (matches.length !== 1) return null;
  const category = matches[0][0];
  return { category, ...pricingConfig.calculator.assembly.fallbackProfiles[category] };
}

export function assemblyForProduct(product, context) {
  const time = product.manufacturerAssembly;
  const profile = /^(ambiguous_|conflicting_)/.test(time.reason || '') || time.people > 2 ? null : fallbackProfile(product, context);
  const rules = pricingConfig.calculator.assembly;
  const manufacturerTotal = time.status === 'confirmed'
    ? { minutesMin: time.minutesMin * product.quantity, minutesMax: time.minutesMax * product.quantity, people: time.people } : null;
  // Brak liczby osób nie pozwala przeliczyć deklaracji producenta na koszt ekipy.
  // Można wtedy pokazać czas producenta, a roboczy oszacować osobno po kategorii.
  const confirmedWork = time.status === 'confirmed' && [1, 2].includes(time.people);
  const working = confirmedWork ? {
    basis: 'manufacturer_adjusted', people: time.people,
    minutesMin: Math.ceil(time.minutesMin * rules.manufacturerFactorMin + rules.perItemHandlingMinutes),
    minutesMax: Math.ceil(time.minutesMax * rules.manufacturerFactorMax + rules.perItemHandlingMinutes)
  } : profile ? { basis: 'category_estimate', category: profile.category, people: profile.people,
    minutesMin: profile.minutesMin, minutesMax: profile.minutesMax } : null;
  return { manufacturer: time, manufacturerTotal, working: working ? { ...working,
    totalMinutesMin: working.minutesMin * product.quantity, totalMinutesMax: working.minutesMax * product.quantity } : null };
}

export function calculateAssemblyQuote(products, context) {
  const known = products.filter(product => product.assembly.manufacturerTotal);
  const completeManufacturer = known.length === products.length;
  const manufacturer = {
    complete: completeManufacturer,
    confirmedUnits: known.reduce((sum, product) => sum + product.quantity, 0),
    totalUnits: products.reduce((sum, product) => sum + product.quantity, 0),
    minutesMin: known.length ? known.reduce((sum, product) => sum + product.assembly.manufacturerTotal.minutesMin, 0) : null,
    minutesMax: known.length ? known.reduce((sum, product) => sum + product.assembly.manufacturerTotal.minutesMax, 0) : null
  };
  const manual = context.furnitureType !== 'Meble z paczek' || products.some(product => !product.assembly.working);
  if (manual) return { pricingBasis: 'manual', requiresManualQuote: true, manufacturer, working: null,
    installation: null, installationMin: null, installationMax: null };
  const rules = pricingConfig.calculator.assembly;
  const people = Math.max(...products.map(product => product.assembly.working.people));
  // Nie dzielimy czasu przez liczbę monterów. Jedna ekipa montuje bryły kolejno.
  const working = { people, minutesMin: rules.jobSetupMinutes + products.reduce((sum, product) => sum + product.assembly.working.totalMinutesMin, 0),
    minutesMax: rules.jobSetupMinutes + products.reduce((sum, product) => sum + product.assembly.working.totalMinutesMax, 0),
    hourlyRate: people === 2 ? pricingConfig.publicRates.hourlyTwoInstallers : pricingConfig.publicRates.hourlyOneInstaller,
    basis: products.every(product => product.assembly.working.basis === 'manufacturer_adjusted') ? 'manufacturer_adjusted' : 'includes_category_estimate' };
  const installationMin = roundMoney(Math.max(pricingConfig.publicRates.minimumJob, working.minutesMin / 60 * working.hourlyRate));
  const installationMax = roundMoney(Math.max(pricingConfig.publicRates.minimumJob, working.minutesMax / 60 * working.hourlyRate));
  return { pricingBasis: 'assembly_time', requiresManualQuote: false, manufacturer, working,
    installation: installationMax, installationMin, installationMax };
}
