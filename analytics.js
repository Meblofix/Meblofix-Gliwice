(function () {
  'use strict';

  const EVENT_PROPERTIES = Object.freeze({
    quote_started: Object.freeze({
      productCount: value => Number.isInteger(value) && value >= 0 && value <= 10,
      hasExtraServices: value => value === true || value === false
    }),
    quote_success: Object.freeze({
      productCount: value => Number.isInteger(value) && value >= 1 && value <= 10,
      hasExtraServices: value => value === true || value === false
    }),
    quote_individual: Object.freeze({
      reason: value => ['ikea_project', 'price_not_confirmed', 'request_failed'].includes(value),
      productCount: value => Number.isInteger(value) && value >= 1 && value <= 10,
      hasExtraServices: value => value === true || value === false
    }),
    phone_click: Object.freeze({}),
    contact_submit: Object.freeze({
      formKind: value => value === 'contact' || value === 'quote'
    }),
    realization_open: Object.freeze({
      realizationId: value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value)
    }),
    before_after_use: Object.freeze({
      realizationId: value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value),
      comparisonIndex: value => Number.isInteger(value) && value >= 1 && value <= 10
    })
  });

  const sentKeys = new Set();
  const pending = [];
  let retryTimer = 0;
  let retryAttempts = 0;

  function safeProperties(eventName, properties) {
    const schema = EVENT_PROPERTIES[eventName];
    if (!schema || !properties || typeof properties !== 'object' || Array.isArray(properties)) return {};

    return Object.fromEntries(Object.entries(schema).flatMap(([key, isValid]) => {
      const value = properties[key];
      return isValid(value) ? [[key, value]] : [];
    }));
  }

  function send(event) {
    if (!window.zaraz || typeof window.zaraz.track !== 'function') return false;
    Promise.resolve(window.zaraz.track(event.name, event.properties)).catch(() => {});
    return true;
  }

  function flush() {
    retryTimer = 0;
    while (pending.length && send(pending[0])) pending.shift();
    if (!pending.length) {
      retryAttempts = 0;
      return;
    }
    if (retryAttempts < 10) {
      retryAttempts += 1;
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (retryTimer) return;
    if (pending.length > 20) pending.splice(0, pending.length - 20);
    retryTimer = window.setTimeout(flush, 500);
  }

  function track(eventName, properties = {}, onceKey = '') {
    if (!Object.prototype.hasOwnProperty.call(EVENT_PROPERTIES, eventName)) return false;
    if (onceKey && sentKeys.has(onceKey)) return false;
    if (onceKey) sentKeys.add(onceKey);

    const event = { name: eventName, properties: safeProperties(eventName, properties) };
    if (!send(event)) {
      pending.push(event);
      scheduleFlush();
    }
    return true;
  }

  window.MeblofixAnalytics = Object.freeze({ track });
  window.addEventListener('load', flush, { once: true });

  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href^="tel:"]');
    if (!link) return;
    track('phone_click');
  }, { capture: true });
})();
