# Meblofix Gliwice

Strona usług montażu mebli dla Gliwic i okolic.

## Lokalny podgląd

python3 -m http.server 8080

http://localhost:8080

Sam statyczny podgląd nie obsługuje funkcji API kalkulatora. Pełny, bezpieczny
podgląd kalkulatora uruchom w trybie testowym Cloudflare:

```bash
bash scripts/build-cloudflare.sh
npx --no-install wrangler pages dev dist \
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

Projekt przypina `wrangler` w wersji `4.120.0` w `devDependencies` i
`package-lock.json`. Po `npm ci` zarówno build, lokalny podgląd, jak i deploy
powinny korzystać z lokalnej wersji przez `npx --no-install wrangler ...`.
Artefakt z `bash scripts/build-cloudflare.sh` można wdrożyć bez przepakowania:

```bash
npx --no-install wrangler pages deploy dist \
  --project-name=meblofix-gliwice-prod \
  --branch=main \
  --commit-hash="$(git rev-parse HEAD)"
```

## Automatyczny deployment

Push do gałęzi `main` uruchamia workflow GitHub Actions
`.github/workflows/deploy-cloudflare.yml`. Workflow:

1. pobiera dokładny commit z GitHub,
2. ustawia Node.js 22 i cache npm,
3. instaluje zależności przez `npm ci`,
4. uruchamia `npm run test:quote`,
5. buduje `dist` przez `bash scripts/build-cloudflare.sh`,
6. sprawdza `git diff --check` i zawartość `dist`,
7. wdraża `dist` do istniejącego projektu `meblofix-gliwice-prod`, przekazując
   Cloudflare pełny identyfikator `GITHUB_SHA`.

Każdy krok musi zakończyć się powodzeniem. Błąd instalacji, testów, buildu,
formatu diffu albo kontroli `dist` zatrzymuje job przed deploymentem. Workflow
nie wykonuje automatycznego deploymentu z innych gałęzi. Grupa concurrency
`meblofix-production` anuluje starszy, trwający run po kolejnym pushu do `main`.

Repozytorium GitHub wymaga dwóch Actions secrets:

- `CLOUDFLARE_API_TOKEN` — własny token CI ograniczony do uprawnienia
  `Account / Cloudflare Pages / Edit` dla właściwego konta,
- `CLOUDFLARE_ACCOUNT_ID` — `14ae31cb57787d648c3c1013507580a4`.

Nie używaj Global API Key ani tokenu z prawami DNS. Sekrety projektu Pages
`QUOTE_NOTIFICATION_SECRET`, `QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT` oraz
binding `QUOTE_NOTIFICATION_KV` pozostają w konfiguracji Cloudflare i nie są
kopiowane do GitHub.

Sekrety można dodać w GitHub: `Settings → Secrets and variables → Actions`, albo
przez zalogowane GitHub CLI bez umieszczania tokenu w historii poleceń:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo Meblofix/Meblofix-Gliwice
printf '%s' '14ae31cb57787d648c3c1013507580a4' | \
  gh secret set CLOUDFLARE_ACCOUNT_ID --repo Meblofix/Meblofix-Gliwice
```

Pierwsza komenda oczekuje bezpiecznego wprowadzenia tokenu przez standardowe
wejście. Nie zapisuj tokenu w pliku, argumencie polecenia ani logu workflow.

### Awaryjny ręczny deployment

Ręczny deployment wykonuj tylko z `main`, gdy `HEAD` jest zgodny z
`origin/main`, po przejściu tych samych bramek co w CI:

```bash
npm ci
npm run test:quote
bash scripts/build-cloudflare.sh
git diff --check
bash scripts/check-cloudflare-dist.sh
npx --no-install wrangler pages deploy dist \
  --project-name=meblofix-gliwice-prod \
  --branch=main \
  --commit-hash="$(git rev-parse HEAD)"
```

Ręczny deploy również korzysta z lokalnego `wrangler@4.120.0`. Nie zmienia DNS,
domeny ani konfiguracji istniejących sekretów i KV projektu Pages.

## Powiadomienia automatycznej wyceny

Cloudflare Pages musi mieć skonfigurowane:

- sekret `QUOTE_NOTIFICATION_SECRET` o długości co najmniej 32 znaków,
- binding KV `QUOTE_NOTIFICATION_KV` do deduplikacji i limitowania wysyłki,
- zaszyfrowaną zmienną `QUOTE_NOTIFICATION_FORMSPREE_ENDPOINT` z pełnym adresem
  osobnego formularza Formspree przeznaczonego tylko do automatycznych powiadomień.

Kalkulator obsługuje backendowy schemat `extraServices` (`serviceId` i
`quantity`). Frontend nie zawiera ani nie przesyła cen jednostkowych: wszystkie
stawki usług są wybierane z jednej, kontrolowanej tabeli w
`functions/api/quote-products.js`, niezależnie od miejscowości. Nieznany
`serviceId`, duplikat lub ilość spoza zakresu 1–10 są odrzucane. Podpisany token
HMAC obejmuje pełną, obliczoną po stronie serwera listę usług i ich wartości.
Payload tokenu v2 jest dodatkowo szyfrowany AES-GCM, dzięki czemu ceny
jednostkowe usług nie są widoczne w odpowiedzi API ani po zdekodowaniu tokenu.

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
