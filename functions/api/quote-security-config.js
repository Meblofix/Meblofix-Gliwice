// Wszystkie bariery czasowe kalkulatora i powiadomień są zebrane tutaj,
// aby zmiana jednej ochrony nie zmieniała przypadkiem pozostałych.
export const QUOTE_SECURITY_LIMITS = Object.freeze({
  // Chroni kosztowne pobieranie stron produktów przed serią żądań z jednego IP.
  productsPerMinute: 15,
  // Chroni wejście endpointu powiadomień przed masowym sprawdzaniem tokenów.
  notificationsPerMinute: 20,
  // Ogranicza liczbę przyjętych powiadomień z jednego publicznego IP w godzinie.
  notificationsPerHour: 40,
  // Okna limitów minutowych i godzinowego.
  minuteWindowMs: 60_000,
  hourWindowMs: 3_600_000,
  // Rekord licznika minutowego przeżywa zmianę granicy minuty.
  minuteRateRecordTtlSeconds: 120,
  // Rekord licznika godzinowego przeżywa zmianę granicy godziny.
  hourlyRateRecordTtlSeconds: 3_700,
  // Identyczna treść zgłoszenia jest scalana przez pięć minut.
  notificationDedupeTtlSeconds: 300,
  // Ten sam quoteId nie może zostać użyty ponownie przez trzydzieści minut.
  quoteReplayTtlSeconds: 1_800,
  // Podpisany token wyceny można przedstawić endpointowi przez dwadzieścia minut.
  quoteTokenLifetimeMs: 20 * 60_000
});
