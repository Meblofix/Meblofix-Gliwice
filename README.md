# Meblofix Gliwice

Strona usług montażu mebli dla Gliwic i okolic.

## Lokalny podgląd

python3 -m http.server 8080

http://localhost:8080

Sam statyczny podgląd nie obsługuje funkcji API kalkulatora. Pełny, bezpieczny
podgląd kalkulatora uruchom w trybie testowym Cloudflare:

```bash
bash scripts/build-cloudflare.sh
npx --yes wrangler@4.68.1 pages dev dist \
  --kv QUOTE_NOTIFICATION_KV \
  --binding QUOTE_NOTIFICATION_SECRET=lokalny-sekret-o-dlugosci-minimum-32-znakow \
  --binding QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT=https://formspree.io/f/lokalnytest \
  --binding QUOTE_NOTIFICATION_MODE=test \
  --ip 127.0.0.1 \
  --port 8788
```

Adres podglądu: http://127.0.0.1:8788

`QUOTE_NOTIFICATION_MODE=test` zatrzymuje wysyłkę przed Formspree. Nie używaj
tej zmiennej w produkcji.

## Powiadomienia automatycznej wyceny

Cloudflare Pages musi mieć skonfigurowane:

- sekret `QUOTE_NOTIFICATION_SECRET` o długości co najmniej 32 znaków,
- binding KV `QUOTE_NOTIFICATION_KV` do deduplikacji i limitowania wysyłki,
- zaszyfrowaną zmienną `QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT` z pełnym adresem
  osobnego formularza Formspree przeznaczonego tylko do automatycznych powiadomień.

Sekret i endpoint Formspree należy dodać w ustawieniach projektu Cloudflare jako
zaszyfrowane zmienne. Nie zapisuj ich w repozytorium, publicznej konfiguracji ani
w kodzie JavaScript przeglądarki. Endpoint automatycznych powiadomień musi być
oddzielny od formularza kontaktowego klienta. Brak lub nieprawidłowa wartość
`QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT` powoduje kontrolowaną odpowiedź 503 bez
próby wysyłki i bez ujawniania konfiguracji.

Formularz kontaktowy strony i automatyczne powiadomienia korzystają z dwóch
różnych formularzy Formspree. Docelowy adres e-mail automatycznych powiadomień
jest przypisany do osobnego formularza na koncie Formspree i nie jest ujawniany
przez kod strony. Przed wdrożeniem należy potwierdzić odbiorcę tego formularza w
panelu Formspree.

Każda poprawna wycena otrzymuje generowany na backendzie losowy `quoteId` i
podpisany token HMAC ważny przez 20 minut. Po udanej wysyłce zapisywany jest
rekord `notification:<quoteId>` z TTL 30 minut. Cloudflare KV ma spójność
eventual: deduplikacja i limit 5 prób na godzinę są ochroną best-effort, a nie
ścisłą, globalnie atomową gwarancją. Lokalna blokada `inFlight` dodatkowo chroni
przed równoległym wysłaniem tylko w obrębie tego samego isolate.
