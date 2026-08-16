import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const project = resolve(import.meta.dirname, '..');
const analyticsSource = readFileSync(resolve(project, 'analytics.js'), 'utf8');
const homepage = readFileSync(resolve(project, 'index.html'), 'utf8');

function analyticsRuntime(withZaraz = true) {
  const calls = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const window = {
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    setTimeout() { return 1; }
  };
  if (withZaraz) {
    window.zaraz = { track(name, properties) { calls.push({ name, properties }); } };
  }
  const document = {
    addEventListener(name, listener) { documentListeners.set(name, listener); }
  };
  vm.runInNewContext(analyticsSource, { window, document, Object, Promise, Set });
  return { calls, documentListeners, windowListeners, window };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('zdarzenia przepuszczają tylko zamknięty zestaw właściwości bez PII', () => {
  const runtime = analyticsRuntime();
  const accepted = runtime.window.MeblofixAnalytics.track('quote_success', {
    productCount: 2,
    hasExtraServices: true,
    name: 'Jan',
    email: 'jan@example.com',
    phone: '+48123456789',
    productUrl: 'https://example.com/private?token=x',
    quoteId: 'secret'
  });

  assert.equal(accepted, true);
  assert.deepEqual(plain(runtime.calls), [{
    name: 'quote_success',
    properties: { productCount: 2, hasExtraServices: true }
  }]);
  assert.equal(runtime.window.MeblofixAnalytics.track('unknown_event', { productCount: 2 }), false);
});

test('onceKey blokuje duplikat tego samego zdarzenia', () => {
  const runtime = analyticsRuntime();
  const tracker = runtime.window.MeblofixAnalytics;

  assert.equal(tracker.track('before_after_use', {
    realizationId: 'kuchnia-obi-gliwice',
    comparisonIndex: 1
  }, 'before-after:kuchnia-obi-gliwice:1'), true);
  assert.equal(tracker.track('before_after_use', {
    realizationId: 'kuchnia-obi-gliwice',
    comparisonIndex: 1
  }, 'before-after:kuchnia-obi-gliwice:1'), false);
  assert.equal(runtime.calls.length, 1);
});

test('zdarzenie oczekuje na automatycznie wstrzyknięty Zaraz bez dodatkowego requestu', () => {
  const runtime = analyticsRuntime(false);
  runtime.window.MeblofixAnalytics.track('quote_started', {
    productCount: 0,
    hasExtraServices: false
  }, 'quote:1:started');
  assert.equal(runtime.calls.length, 0);

  runtime.window.zaraz = { track(name, properties) { runtime.calls.push({ name, properties }); } };
  runtime.windowListeners.get('load')();
  assert.deepEqual(plain(runtime.calls), [{
    name: 'quote_started',
    properties: { productCount: 0, hasExtraServices: false }
  }]);
});

test('jedno kliknięcie tel: emituje dokładnie jedno phone_click i nie blokuje linku', () => {
  const runtime = analyticsRuntime();
  const click = runtime.documentListeners.get('click');
  let prevented = false;
  click({
    target: { closest: selector => selector === 'a[href^="tel:"]' ? { href: 'tel:+48784878197' } : null },
    preventDefault() { prevented = true; }
  });

  assert.deepEqual(plain(runtime.calls), [{ name: 'phone_click', properties: {} }]);
  assert.equal(prevented, false);
});

test('integracja formularzy i kalkulatora emituje konwersje dopiero w poprawnych gałęziach', () => {
  const calculate = homepage.slice(homepage.indexOf('async function calculateFromLinks'), homepage.indexOf('async function sendCalculationNotice'));
  assert.equal((calculate.match(/track\('quote_started'/g) || []).length, 1);
  assert.equal((calculate.match(/track\('quote_success'/g) || []).length, 1);
  assert.equal((calculate.match(/track\('quote_individual'/g) || []).length, 3);
  assert.ok(calculate.indexOf("if (!data.quote) throw") < calculate.indexOf("track('quote_success'"));
  assert.ok(calculate.indexOf("showIndividualQuote(planner.error") < calculate.indexOf("reason: 'ikea_project'"));
  assert.ok(calculate.indexOf("showIndividualQuote('Nie udało się potwierdzić ceny wszystkich produktów") < calculate.indexOf("reason: 'price_not_confirmed'"));

  const quoteSubmitStart = homepage.indexOf('async function handleQuoteSubmit');
  const quoteSubmit = homepage.slice(quoteSubmitStart, homepage.indexOf("document.querySelectorAll('[data-extra-service]')", quoteSubmitStart));
  assert.ok(quoteSubmit.indexOf('if (!response.ok) throw') < quoteSubmit.indexOf("track('contact_submit'"));
  const contactSubmitStart = homepage.indexOf('async function handleSubmit');
  const contactSubmit = homepage.slice(contactSubmitStart, homepage.indexOf('// Aktywny link w nav', contactSubmitStart));
  assert.ok(contactSubmit.indexOf('if (response.ok)') < contactSubmit.indexOf("track('contact_submit'"));
  assert.equal((quoteSubmit.match(/track\('contact_submit'/g) || []).length, 1);
  assert.equal((contactSubmit.match(/track\('contact_submit'/g) || []).length, 1);
});

test('źródła nie zawierają ręcznego beacona Cloudflare ani danych formularzy w eventach', () => {
  assert.doesNotMatch(analyticsSource, /static\.cloudflareinsights\.com|cloudflareinsights\.com\/cdn-cgi\/rum/);
  assert.doesNotMatch(analyticsSource, /dodatkowe_informacje|quoteDetails|FormData|notificationToken/);
  assert.match(homepage, /<link rel="canonical" href="https:\/\/meblofix-gliwice\.pl\/">/);
  assert.doesNotMatch(homepage.match(/<link rel="canonical"[^>]+>/)[0], /utm_|\?/);
});
