(function exposeQuoteDistance(root) {
  'use strict';

  function normalizeCity(value) {
    return String(value ?? '').trim().toLocaleLowerCase('pl-PL');
  }

  function isOriginCity(city, originCity = 'Gliwice') {
    return normalizeCity(city) === normalizeCity(originCity);
  }

  function mapsDirectionsUrl(city, originCity = 'Gliwice') {
    const origin = encodeURIComponent(String(originCity || 'Gliwice').trim() || 'Gliwice');
    const destination = String(city ?? '').trim();
    return `https://www.google.com/maps/dir/${origin}${destination ? `/${encodeURIComponent(destination)}` : ''}`;
  }

  function suggestedDistance(city, suggestions) {
    const cityKey = normalizeCity(city);
    const match = suggestions.find(item => normalizeCity(item.name) === cityKey);
    return Number.isInteger(match?.distanceOneWayKilometers) && match.distanceOneWayKilometers >= 0
      ? match.distanceOneWayKilometers
      : null;
  }

  function deriveDistanceState({ city, originCity = 'Gliwice', previousCityKey = '', currentValue = '', suggestions = [] }) {
    const cityKey = normalizeCity(city);
    const cityChanged = cityKey !== previousCityKey;
    const local = isOriginCity(city, originCity);
    let value = String(currentValue ?? '');
    if (local) value = '0';
    else if (cityChanged) {
      const suggestion = suggestedDistance(city, suggestions);
      value = suggestion == null ? '' : String(suggestion);
    }
    return {
      cityKey,
      cityChanged,
      hidden: local,
      required: !local,
      minimum: local ? 0 : 1,
      value,
      mapsUrl: mapsDirectionsUrl(city, originCity)
    };
  }

  function validateDistance({ city, value, originCity = 'Gliwice', maximumDistance }) {
    if (!String(city ?? '').trim()) {
      return { valid: false, field: 'city', message: 'Podaj miejscowość.' };
    }
    if (isOriginCity(city, originCity)) return { valid: true, distance: 0 };
    if (String(value ?? '').trim() === '') {
      return {
        valid: false,
        field: 'distance',
        message: 'Podaj orientacyjną odległość w jedną stronę od Gliwic.'
      };
    }
    const distance = Number(value);
    if (!Number.isInteger(distance)) {
      return { valid: false, field: 'distance', message: 'Odległość musi być liczbą całkowitą.' };
    }
    if (distance < 1) {
      return {
        valid: false,
        field: 'distance',
        message: 'Dla miejscowości poza Gliwicami podaj co najmniej 1 km.'
      };
    }
    if (!Number.isInteger(maximumDistance) || distance > maximumDistance) {
      return {
        valid: false,
        field: 'distance',
        message: `Podaj odległość nie większą niż ${maximumDistance} km — to deklarowany obszar działania.`
      };
    }
    return { valid: true, distance };
  }

  root.MeblofixQuoteDistance = Object.freeze({
    normalizeCity,
    isOriginCity,
    mapsDirectionsUrl,
    suggestedDistance,
    deriveDistanceState,
    validateDistance
  });
})(typeof window === 'undefined' ? globalThis : window);
