# PLAN NAPRAWY I ROZWOJU — meblofix-gliwice.pl

> Dokument roboczy. Odhaczaj `[ ]` → `[x]` w miarę postępu.
> Wersja: 2.4 · Utworzono: 30.07.2026 · Zaktualizowano: 31.07.2026 (Faza 1: dostępność 83 → 96, agentowe 2/2; jedna dogrywka kontrastu czeka na deploy) · Podstawa: audyt z 29.07.2026 + inspekcja strony na żywo

**Legenda priorytetów**
`P0` bloker — robić natychmiast · `P1` wysoki · `P2` średni · `P3` rozwojowy

**Cel nadrzędny:** naprawić błędy blokujące indeksowanie, a następnie zbudować przewidywalny strumień ruchu z wyszukiwarki i wizytówki Google, wsparty galerią realizacji i systemem opinii/komentarzy.

---

## SPIS FAZ

| Faza | Zakres | Priorytet | Szac. czas |
|---|---|---|---|
| 0 | Diagnostyka i blokery | P0 | 3–4 h |
| 1 | Dostępność (83 → 95+) | P1 | 3–4 h |
| 2 | Wydajność i Core Web Vitals | P1 | 3–4 h |
| 3 | Galeria realizacji | P1 | 6–10 h |
| 4 | Opinie i komentarze | P1 | 8–12 h |
| 5 | Treść i SEO — silnik ruchu | P2 | ciągłe |
| 6 | Wizytówka Google i lokalne SEO | P2 | 4–6 h + ciągłe |
| 7 | Analityka i pomiar | P2 | 2–3 h |
| 8 | Konwersja | P3 | 4–6 h |
| 9 | Meble na wymiar — nowa linia biznesowa | P3 | 20–30 h + decyzje biznesowe |

---

# FAZA 0 — DIAGNOSTYKA I BLOKERY `P0`

## ✅ ROZSTRZYGNIĘTE 30.07.2026 — błędu wydajności nie było

Czysty pomiar (incognito, bez rozszerzeń, okno na wierzchu) dał: **Wydajność 84 / Dostępność 83 / Praktyki 96 / SEO 100** (mobile, Slow 4G).

Wcześniejszy `NO_FCP` był artefaktem środowiska: dane w IndexedDB, okno przeglądarki w tle podczas pomiaru, rozszerzenia Brave wstrzykujące skrypty (Sentry). Audyt z 29.07 prawdopodobnie trafił na to samo.

**Nieaktualne wnioski, które należy zignorować:**
- ~~Cloudflare (Rocket Loader, Bot Fight Mode)~~ — hosting to Netlify, Cloudflare nie ma w torze
- ~~Wiszące zapytania Supabase~~ — `sbFetch` ma try/catch i fallback `DEFAULT_REVIEWS`; backend odpowiada w 50–200 ms
- ~~Wstrzymany projekt Supabase~~ — projekt działa
- ~~„Ładowanie opinii…" i „Odwiedzin: —" jako awarie~~ — to stan początkowy HTML przed podmianą przez JS

**Zasada na przyszłość — środowisko pomiarowe.** Brave z rozszerzeniami wprowadziło nas w błąd czterokrotnie w ciągu jednej sesji:
1. Błąd Sentry w konsoli — pochodził z rozszerzenia, nie ze strony
2. `NO_FCP` w Lighthouse — IndexedDB + okno w tle
3. Wszystkie requesty jako `(pending)` — wstrzymany debugger („Pause on caught exceptions" łapało obsłużony wyjątek z `sbFetch`)
4. Trzy fantomowe pliki `DM-Sans-*.woff2` — wstrzyknięte przez rozszerzenie (widoczne po dodaniu kolumny **Domain** w panelu Network)

**Reguła: każdy pomiar i każda diagnostyka wyłącznie w oknie incognito, bez emulacji urządzenia, z oknem na wierzchu.** Kontrola krzyżowa przez `curl` na produkcji rozstrzyga każdy taki spór w 5 sekund.

## ✅ WYKONANE 30.07.2026

- [x] Fonty przeniesione z Google Fonts na hosting lokalny (6 plików `.woff2`, ~100 kB, inline `@font-face` + preload Bebas Neue)
- [x] Zweryfikowano polskie znaki — wariant `latin-ext` działa poprawnie
- [x] `robots.txt` po raz pierwszy wdrożony na produkcję (wcześniej untracked → 404)
- [x] Wdrożone na produkcję i potwierdzone: `grep -c fonts.googleapis` = 0, fonty z własnej domeny = 200
- [x] Ustalono, że repo nie zawiera **żadnego** obrazu — brak hero, favicony, `og:image`

### Wynik po wdrożeniu (PSI produkcja, 30.07.2026, 22:46)

| Metryka | Przed | Po |
|---|---|---|
| Wydajność mobile | 84 | **99** |
| Wydajność desktop | — | **100** |
| FCP | 3,4 s | **1,0 s** |
| LCP | 3,4 s | **2,1 s** |
| Speed Index | 3,4 s | **1,7 s** |
| TBT | 0 ms | 0 ms |
| CLS | 0 | 0 |

„Render-blocking requests" zniknęło z listy statystyk. **Faza 2 zamknięta** — pozostała pozycja „Minifikuj CSS, 2 KiB" nie jest warta osobnej sesji.

Cel: PageSpeed Insights zwraca **liczbę zamiast błędu**, żaden element strony nie wisi w stanie „ładowanie".

## 0.1 Ustalenie przyczyny błędu wydajności

Hipoteza główna: wiszące zapytania sieciowe (opinie + licznik odwiedzin) nie kończą się, Lighthouse nie osiąga stanu *network idle* i przerywa pomiar.

- [ ] Otwórz stronę w Chrome → DevTools → zakładka **Network**, filtr `Fetch/XHR`. Sprawdź, czy któryś request zostaje w stanie *pending* dłużej niż 10 s. Zapisz jego URL i status.
- [ ] DevTools → **Console**. Zapisz wszystkie błędy JS (czerwone). Każdy błąd przed renderem = potencjalna przyczyna `NO_LCP`.
- [ ] DevTools → **Lighthouse** → tryb *Navigation*, urządzenie *Mobile*, throttling domyślny. Uruchom lokalnie.
      - Przechodzi lokalnie, a PSI zwraca błąd → problem po stronie hostingu/firewalla (→ 0.2)
      - Nie przechodzi lokalnie → problem w kodzie strony (→ 0.3)
- [ ] Search Console → *Sprawdzenie adresu URL* → **Testuj URL na żywo** → obejrzyj „Wyrenderowany HTML" i zrzut ekranu. Zapisz, czy Googlebot widzi pełną treść.
- [ ] Przejrzyj logi serwera z 29.07.2026, szukaj User-Agent zawierającego `Chrome-Lighthouse` oraz `Google Page Speed Insights`. Zanotuj kody odpowiedzi.

## 0.2 Hosting: Netlify (potwierdzone nagłówkami)

Strona jest serwowana bezpośrednio przez Netlify — brak nagłówka `cf-ray`, obecne `server: Netlify` i `x-nf-request-id`. Cloudflare, jeśli w ogóle występuje, to wyłącznie jako DNS z wyłączonym proxy. **Ustawienia typu Rocket Loader czy Bot Fight Mode nie mają tu zastosowania** — nie szukaj tam przyczyny.

Konsekwencja: hipoteza wiszących zapytań (0.3) wraca na pierwsze miejsce jako najbardziej prawdopodobne źródło błędu PSI. Netlify nie blokuje Lighthouse i ma szybki CDN, więc winowajca jest niemal na pewno w kodzie strony.

- [ ] Sprawdź, czy `robots.txt` i `sitemap.xml` w ogóle istnieją na produkcji:
      `curl -s https://meblofix-gliwice.pl/robots.txt | head -5`
      `curl -sI https://meblofix-gliwice.pl/sitemap.xml | head -1`
      Lokalny `robots.txt` jest untracked → prawdopodobnie nigdy nie został wdrożony.
- [ ] Netlify → Deploys: sprawdź status ostatniego deployu i log budowania. Ostatni commit to „Wymuszenie redeploy Netlify" (09.06.2026) — warto ustalić, co wtedy nie zadziałało.
- [ ] Netlify → Site configuration → Build & deploy: potwierdź, które repo i który branch są podpięte (musi się zgadzać z `Twoja-chwila/Twoja-chwila-Meblofix-Gliwice`).
- [ ] Brak pliku `netlify.toml` w repo → brak konfiguracji nagłówków. Utwórz go z regułami cache i nagłówkami bezpieczeństwa (patrz 2.2).
- [ ] Sprawdź, czy w panelu Netlify nie jest włączone Asset Optimization (bundling/minify JS i CSS) — potrafi psuć kod, podobnie jak minifikacja u innych dostawców. Wyłącz na czas diagnostyki.
- [ ] Zmierz TTFB: `curl -w "%{time_starttransfer}\n" -o /dev/null -s https://meblofix-gliwice.pl/` — cel < 0,6 s.
- [ ] Sprawdź przekierowania: `curl -IL https://meblofix-gliwice.pl/` — warianty `www`/bez, `http`/`https`, ze slashem/bez.
- [ ] Zmierz TTFB: `curl -w "%{time_starttransfer}\n" -o /dev/null -s https://meblofix-gliwice.pl/` — cel < 0,6 s.
- [ ] Sprawdź, czy nie ma pętli przekierowań (`curl -IL https://meblofix-gliwice.pl/`), zwłaszcza na wariantach: `www` / bez `www`, `http` / `https`, ze slashem / bez slasha.

## 0.3 Realne usterki potwierdzone w konsoli i w kodzie

- [ ] **Brakujące zdjęcie hero — 404.** `index.html:2018` odwołuje się do `meblofix_foto.jpeg`, którego nie ma ani w repo, ani na produkcji. Atrybut `onerror` maskuje problem (dodaje `image-missing` i usuwa element), dlatego nikt tego nie zauważył. Odtwórz z historii (`git log --all -- meblofix_foto.jpeg`) albo wgraj nowy plik.
- [ ] **Brak `og:image` i `twitter:image`.** Przy `twitter:card: summary_large_image` oznacza to, że każde udostępnienie linku na FB/WhatsApp/LinkedIn pokazuje goły tekst bez miniatury. Jedno dobre zdjęcie naprawia hero i podgląd społecznościowy naraz.
- [ ] **Klucz Supabase zwraca 401.** W przeglądarce klucz jest wysyłany i odrzucany — wygasł lub został zrotowany (Supabase wycofuje stare klucze `eyJ...`). Pobierz aktualny z Settings → API i podmień. To wyjaśnia licznik „—".
- [ ] **`favicon.ico` — 404.** Kosmetyka, ale widoczna w karcie przeglądarki.
- [ ] Po naprawie tych czterech: audyt „Browser errors were logged to the console" w Best Practices przestanie zgłaszać błąd.
- [ ] Mimo działającego try/catch — dopisz timeout do `sbFetch` (`index.html:2693`). Dziś Supabase odpowiada w 50 ms, ale przy awarii `await fetch` czeka bez limitu. Jedno miejsce, obejmuje wszystkie wywołania:

```js
async function safeFetch(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    console.warn('safeFetch failed:', url, e);
    return null;            // NIGDY nie zostawiaj wiszącej obietnicy
  } finally {
    clearTimeout(t);
  }
}
```

- [ ] **Opinie:** `DEFAULT_REVIEWS` przenieś z JS do HTML. Nie z powodu wydajności — chodzi o to, że Googlebot w pierwszym przejściu widzi surowy HTML, czyli napis „Ładowanie opinii…" zamiast treści. Renderowanie JS Google wykonuje z opóźnieniem i nie zawsze.
- [ ] **Licznik odwiedzin:** usuń ze stopki. Zero wartości dla klienta, jedno wywołanie sieciowe mniej, jeden błąd 401 mniej. Statystyki i tak masz w analityce (Faza 7).
- [ ] Przenieś wszystkie skrypty niekrytyczne na `defer` lub `type="module"`; żaden `<script>` blokujący w `<head>`.

## 0.4 Martwe elementy interfejsu

- [ ] Przycisk hero „Zadzwoń lub napisz" ma `href="#"` → zamień na `href="tel:+48784878197"`.
- [ ] Przycisk telefonu w nawigacji ma `href="#"` → to samo.
- [ ] Zasada: **każdy przycisk ma działający `href` również przy wyłączonym JS**. JS może przechwycić kliknięcie, ale nie może być warunkiem działania.
- [ ] Link „Znajdź nas w Google Maps" → `maps.app.goo.gl/MebloFixGliwice` to nie jest prawdziwy skrócony link Google (te mają losowy hash). Podmień na autentyczny link z wizytówki.
- [ ] Przetestuj formularz kontaktowy: wyślij testowe zgłoszenie i potwierdź, że dotarło. Jeśli nie — napraw endpoint przed czymkolwiek innym.
- [ ] Dodaj widoczny komunikat po wysłaniu formularza (nie `alert()`), z informacją o czasie odpowiedzi.
- [ ] Kliknij każdy link na stronie głównej i podstronach; zapisz wszystkie 404.

## 0.5 Weryfikacja końcowa fazy 0

- [ ] PSI (mobile) zwraca liczbę zamiast błędu
- [ ] PSI (desktop) zwraca liczbę zamiast błędu
- [ ] Żadnego „Ładowanie…" ani „—" na stronie
- [ ] Zero błędów w konsoli
- [ ] Test na żywo w Search Console renderuje pełną treść

---

# FAZA 1 — DOSTĘPNOŚĆ `P1`

## ✅ CEL OSIĄGNIĘTY 31.07.2026 — dostępność 83 → 96, agentowe 1/2 → 2/2

Cel: Lighthouse Accessibility 83 → ≥ 95. Dodatkowo: dostępność to realny czynnik konwersji — część klientów to osoby starsze, korzystające z powiększonej czcionki.

Cztery błędy z audytu naprawione, wynik potwierdzony pomiarem na produkcji (tabela niżej). **Faza nie jest jednak wyczerpana** — punkty bez odhaczenia na końcu sekcji to nadal realna robota, w tym dwa poważne znaleziska: brak menu mobilnego i niewidoczne obramowania pól formularza.

## ✅ CZTERY BŁĘDY LIGHTHOUSE — NAPRAWIONE 31.07.2026

| # | Błąd | Gdzie było | Commit |
|---|---|---|---|
| 1 | `Buttons do not have an accessible name` | 3× `.blog-modal-close` — sam `<svg>`, zero tekstu | `88db9bf` |
| 2 | `Select elements do not have associated label elements` | `<select name="rodzaj_mebli">` w formularzu kontaktowym | `4f57fec` |
| 3 | `Background and foreground colors do not have a sufficient contrast ratio` | 17 miejsc, patrz niżej | `6adc7f9`, `f821c43` |
| 4 | `Identical links have the same purpose` | 3× „Czytaj cały artykuł" pod różne adresy | `e36f4d8` |

**Sprostowanie do opisu błędu 1:** hamburger nie istnieje (patrz „Menu mobilne" niżej), a gwiazdki oceny nie były `<button>`, tylko `<svg onclick>` — dlatego audyt ich nie łapał. Naprawione osobno w `f531645`: opinii nie dało się wysłać bez myszy.

**Sprostowanie do opisu błędu 4:** „Czytaj więcej" to `<span>`, nie link — audyt go nie widział. Flagowane były trzy `<a>` o tekście „Czytaj cały artykuł".

### Punkt 3 w szczegółach

Przyczyna główna: **biały tekst na `--orange` (#E8440A) daje 3,99:1 przy progu 4,5:1** — dotyczyło to wszystkich CTA i plakietek. Zamiast rozjaśniać tekst wprowadzono osobne tło pod biały tekst; `--orange` został bez zmian, bo jako kolor tekstu/ikon na ciemnym tle ma 4,87–4,96:1 i przechodzi.

```css
--orange-btn:       #C43806;  /* z bielą 5,36:1 */
--orange-btn-hover: #A93105;  /* z bielą 6,71:1 — hover ciemnieje, nie jaśnieje */
```

Poprawione też: `.ticker-sep` (1,69 → 4,62:1), `.phone-strip-sub` (2,82 → 4,76:1), `.brand-item` (2,42 → 5,52:1) oraz sekcja opisowa na dole strony — nagłówki 2,90 → 4,96:1, akapity 3,93 → 5,58:1.

Z tej sekcji **usunięto akapit z listą fraz rozdzielonych pipe'ami** („montażysta mebli Gliwice | montaż mebli Śląsk | …"), wyciszony do 2,20:1. To upychanie słów kluczowych, nie treść — rozjaśnienie wyeksponowałoby użytkownikom coś, czego nikt nie ma czytać. Ten sam gatunek co `meta keywords` z punktu 5.2. Komentarz sekcji („widoczny dla Google, dyskretny wizualnie") opisuje teraz zawartość, nie intencję pod robota.

### Wynik po wdrożeniu (PSI produkcja, 31.07.2026, 11:27, incognito)

| Metryka | Przed | Po |
|---|---|---|
| **Dostępność mobile** | 83 | **96** |
| **Dostępność desktop** | — | **96** |
| Wydajność mobile | 99 | 98 |
| Wydajność desktop | 100 | 100 |
| Praktyki | 96 | 96 |
| SEO | 100 | 100 |
| **Przeglądanie agentowe** | 1/2 | **2/2** |

**Cel osiągnięty** — próg z nagłówka fazy to ≥ 95. Błąd „drzewo ułatwień dostępu jest nieprawidłowe" zniknął, zgodnie z przewidywaniem: to była ta sama warstwa semantyki HTML.

### Dogrywka — jedno zgłoszenie kontrastu zostało

Pomiar wykazał, że przy pierwszym przejściu przeoczyłem dwa teksty (commit `dd976be`, **wymaga ponownego deployu i pomiaru**):

| Element | Było | Jest | Próg |
|---|---|---|---|
| `.service-num` — etykiety „01"–„06" | 1,52:1 | 4,87:1 | 4,5 (13,6 px) |
| `.promise-quote-mark` — znak cytatu | 1,21:1 | 3,77:1 | 3,0 (48 px) |

Etykiety „01–06" plan wymieniał **wprost** w punkcie o kontraście poniżej — przeoczenie po mojej stronie: szukałem lokalizacji zawężonym wzorcem i te deklaracje wypadły z listy. Poprawione dopiero po pełnym przemiataniu wszystkich deklaracji `color:` w pliku; po nim żaden węzeł tekstowy nie jest poniżej progu.

**Wniosek na przyszłość:** przy audycie kontrastu nie wystarczy zebrać unikalne *wartości* kolorów — trzeba zebrać wszystkie ich *wystąpienia*. Ta sama wartość potrafi siedzieć w kilku miejscach, z których część przechodzi, a część nie.

Znane, świadomie zostawione: `.star-picker svg` w stanie nieaktywnym ma 1,50:1, ale to ikona (audyt kontrastu obejmuje tylko tekst), a `setStars(5)` na starcie zamalowuje wszystkie gwiazdki na złoto — ten kolor pojawia się dopiero przy ocenie < 5.

Reszta listy poniżej to prewencja i rzeczy, których automat nie wykrywa.

- [x] **Kontrast tekstu.** Przemiecione **wszystkie** deklaracje `color:` w pliku — nie na oko, tylko policzone wg WCAG 2.1. Po commicie `dd976be` żaden węzeł tekstowy nie jest poniżej progu (4,5:1, duży 3:1). Uwzględnione też etykiety „01–06", wymienione w tym punkcie od początku.
- [ ] **Kontrast elementów interaktywnych** (obramowania pól, ikony) — min. 3:1. ⚠️ **Nie zrobione.** `--border: rgba(255,255,255,0.08)` na ciemnym tle to **1,20:1** — obramowania pól formularza są praktycznie niewidoczne. Osobne zadanie, dotyka wielu miejsc naraz.
- [ ] **Etykiety formularza.** Każde pole: `<label for="...">` albo `aria-label`. Placeholder ≠ etykieta. ⚠️ **Częściowo:** poprawiony tylko `<select>` (to on wywalał audyt). Pozostałe pola — imię, telefon, e-mail, miasto, opis zlecenia oraz formularz opinii — nadal stoją na samych placeholderach. Audytu nie wywalają (placeholder liczy się jako nazwa zastępcza), ale znikają, gdy użytkownik zacznie pisać.
- [ ] **Autouzupełnianie:** `autocomplete="name"`, `"tel"`, `"email"` — realnie skraca wypełnianie na telefonie.
- [ ] **FAQ (akordeon).** Nagłówki jako `<button aria-expanded="false" aria-controls="faq-1">`, treść jako `<div id="faq-1" role="region">`. Obsługa klawiatury: Enter/Spacja.
- [x] **Powtarzalne linki.** Trzy `<a>` „Czytaj cały artykuł" dostały `aria-label` z tytułem artykułu. Widoczny tekst bez zmian.
- [ ] **Atrybuty alt.** Zdjęcia treściowe: opisowy alt (jednocześnie SEO obrazkowe). Dekoracyjne: `alt=""`.
- [ ] **Wymiary obrazów.** `width` i `height` na każdym `<img>` — kasuje CLS.
- [ ] **Widoczny focus.** Nie usuwaj outline; zdefiniuj własny `:focus-visible` w kolorze marki, min. 2px. ⚠️ **Częściowo:** zdefiniowany tylko dla gwiazdek oceny (`.star-picker button`). Reszta strony jedzie na domyślnym outline przeglądarki — brakuje jednej globalnej reguły.
- [ ] **Skip link** „Przejdź do treści" jako pierwszy element `<body>`, ukryty do momentu focusa.
- [ ] **Hierarchia nagłówków.** Jeden `<h1>` na stronę, brak przeskoków (h2 → h4).
- [x] **`lang="pl"`** na `<html>` — sprawdzone, jest (`index.html:2`). Bez zmian.
- [ ] **Menu mobilne.** ⚠️ **Znalezisko 31.07.2026: menu mobilnego nie ma w ogóle.** Nie chodzi o brakujące `aria-label` na hamburgerze — hamburger nie istnieje. Poniżej breakpointa `.nav-links { display: none; }` i nic w zamian, więc na telefonie znika cała nawigacja (Usługi, Cennik, Opinie, FAQ, Blog, Kontakt). Zostaje tylko przycisk „Zadzwoń". To nie jest wyłącznie problem dostępności — to utrata nawigacji dla większości ruchu. Do zbudowania od zera: przycisk `aria-label="Menu"` + `aria-expanded`, focus trap, Esc zamyka.
- [x] **Wybór oceny z klawiatury.** Gwiazdki w formularzu opinii były `<svg onclick>` — nie do sfokusowania, nie do aktywowania Enterem. Bez myszy nie dało się wystawić opinii. Zamienione na `<button type="button">` z `aria-label` i `aria-pressed`. Świadoma decyzja: `aria-pressed="true"` dostaje **tylko** gwiazdka równa ocenie, nie wszystkie do niej — inaczej czytnik ogłasza trzy wciśnięte przyciski przy ocenie 3, co brzmi jak trzy wybrane oceny.
- [ ] Test nawigacji **samą klawiaturą** (Tab przez całą stronę) — czy da się dojść do telefonu i formularza. ⚠️ Uwaga: bez menu mobilnego i bez globalnego `:focus-visible` ten test i tak wypadnie słabo — zrobić po tamtych dwóch punktach.
- [ ] Test na 200% powiększenia przeglądarki — czy nic się nie rozjeżdża.

---

# FAZA 2 — WYDAJNOŚĆ I CORE WEB VITALS `P1`

Cel: LCP < 2,5 s, CLS < 0,1, INP < 200 ms na mobile.

**Punkt wyjścia (Lighthouse 30.07.2026, mobile, Slow 4G): wydajność 84.**
FCP 3,4 s · LCP 3,4 s · **TBT 0 ms** · **CLS 0** · SI 3,4 s

TBT i CLS są wzorowe — nie ruszaj tego, co je daje. Cała strata siedzi w czasie do pierwszego renderu.

## ✅ 2.0 Zasoby blokujące render — WYKONANE 30.07.2026 `P1`

Lighthouse: **Render-blocking requests, oszczędność 1 820 ms.** To pojedyncza poprawka, która zbija LCP z 3,4 s do okolic 1,6 s i wynosi wydajność powyżej 90. Wszystko inne w tej fazie to drobiazgi przy tym jednym punkcie.

- [x] Zidentyfikowano bloker: jeden `<link>` do `fonts.googleapis.com` (linia 213)
- [ ] Google Fonts: dodaj `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` i parametr `&display=swap` w URL-u.
- [x] **Fonty hostowane lokalnie** (pobierz pliki `.woff2`, wgraj do repo, zadeklaruj `@font-face` z `font-display: swap`). Usuwa cały round-trip do Google i rozwiązuje kwestię RODO — Google Fonts z CDN przekazuje IP użytkownika do Google.
- [ ] Ogranicz kroje i grubości do faktycznie używanych. Każda dodatkowa waga to osobny plik.
- [ ] Arkusze niekrytyczne ładuj asynchronicznie: `<link rel="preload" as="style" onload="this.rel='stylesheet'">`.
- [x] `@font-face` wstawione inline w `<head>` + preload dla Bebas Neue (element LCP)
- [x] Zweryfikowano wariant `latin-ext` — polskie diakrytyki renderują się poprawnie
- ⚠️ **Uwaga przy przyszłych porządkach:** CSS fontów jest inline, więc `url(fonts/…)` rozwiązuje się względem `index.html`. Przy wydzieleniu do osobnego pliku CSS trzeba zmienić na `url(../fonts/…)`, inaczej fonty znikną.
- [ ] Po każdej zmianie mierz w incognito. Cel: LCP < 2,0 s.

## 2.0b Nagłówki bezpieczeństwa — brakujący `netlify.toml` `P2`

Best Practices 96 traci punkty wyłącznie na brakujących nagłówkach: CSP, HSTS, COOP, X-Frame-Options, Trusted Types. W repo nie ma `netlify.toml`, więc żaden nagłówek nie jest ustawiony. Utwórz plik:

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Strict-Transport-Security = "max-age=31536000; includeSubDomains; preload"
    X-Frame-Options = "SAMEORIGIN"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Cross-Origin-Opener-Policy = "same-origin"
    Permissions-Policy = "geolocation=(), microphone=(), camera=()"

[[headers]]
  for = "/*.jpeg"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"
```

- [ ] Utwórz `netlify.toml` z powyższą zawartością
- [ ] CSP dodaj **na końcu**, po ustabilizowaniu strony — źle napisana polityka potrafi zablokować własne skrypty. Zacznij od `Content-Security-Policy-Report-Only`.
- [ ] Zweryfikuj: `curl -sI https://meblofix-gliwice.pl | grep -i "strict-transport\|x-frame"`

## 2.1 Pozostałe wskazania Lighthouse

- [ ] `Optimize DOM size` — 2991 linii w jednym pliku. Rozwiązuje to punkt 5.1 (artykuły → zajawki).
- [ ] `Minimize main-thread work` 2,9 s, 6 długich zadań — po naprawie fontów zmierz ponownie, część zniknie sama.
- [ ] `Minify CSS` — oszczędność 2 KiB. Najniższy priorytet w całym dokumencie.
- [ ] `3rd parties` — sprawdź, co jeszcze ładuje się z zewnątrz poza Supabase i Formspree.

## 2.2 Obrazy

- [ ] Zważ obecne zdjęcia: `du -h *.jpeg *.jpg *.png`. Wszystko powyżej 200 KB do konwersji.
- [ ] Konwersja do AVIF + WebP z fallbackiem JPEG. Skrypt (WSL):

```bash
# wymaga: sudo apt install imagemagick webp libavif-bin
for f in *.jpg *.jpeg; do
  b="${f%.*}"
  convert "$f" -resize '1600x>' -quality 82 "${b}-1600.jpg"
  cwebp -q 80 "${b}-1600.jpg" -o "${b}-1600.webp"
  avifenc -q 55 "${b}-1600.jpg" "${b}-1600.avif"
done
```

- [ ] Użyj `<picture>` z kolejnością AVIF → WebP → JPEG.
- [ ] Warianty responsywne: 480 / 800 / 1200 / 1600 px + atrybut `sizes`.
- [ ] `loading="lazy"` na wszystkim poniżej pierwszego ekranu; `loading="eager"` + `fetchpriority="high"` na hero.
- [ ] `<link rel="preload" as="image">` na obraz hero.

## 2.3 Kod i ładowanie

- [ ] Odchudź stronę główną: pełne teksty artykułów → zajawki (patrz 5.1). Ogromny DOM = wolniejszy render i gorszy INP.
- [ ] Fonty: `font-display: swap`, `preconnect` do źródła, hostuj lokalnie jeśli to Google Fonts (RODO + szybkość).
- [ ] Usuń nieużywany CSS/JS (DevTools → Coverage).
- [ ] Krytyczny CSS inline w `<head>`, reszta asynchronicznie.
- [ ] Nagłówki cache: `Cache-Control: public, max-age=31536000, immutable` dla assetów z hashem w nazwie; `max-age=3600` dla HTML.
- [ ] Włącz kompresję Brotli/gzip na serwerze.
- [ ] Rezerwuj wysokość dla sekcji ładowanych dynamicznie (opinie, galeria) — inaczej CLS skacze.

## 2.4 Weryfikacja

- [x] PSI mobile 99, desktop 100 — **cel osiągnięty i przekroczony**
- [ ] Search Console → Core Web Vitals — brak adresów w kategorii „Słabe"

---

# FAZA 3 — GALERIA REALIZACJI `P1`

Dlaczego to priorytet: przy usługach montażowych **zdjęcia „przed/po" są najmocniejszym dowodem kompetencji**, jaki możesz pokazać. Galeria to też paliwo dla SEO obrazkowego, dla wizytówki Google i dla postów w social media.

## 3.1 Zbiórka materiału

- [ ] Zbierz zdjęcia z dotychczasowych zleceń — minimum **20 realizacji**, docelowo 40+.
- [ ] Ustal rutynę: **każde zlecenie = zdjęcie przed + po**. Telefon, dobre światło, kadr poziomy, bez prywatnych rzeczy klienta w kadrze.
- [ ] Uzyskaj zgodę klienta na publikację (wystarczy SMS-owe „czy mogę pokazać zdjęcie efektu na stronie?"). Zapisuj zgody.
- [ ] Usuń metadane EXIF (lokalizacja GPS!) przed publikacją: `exiftool -all= *.jpg`

## 3.2 Struktura danych

- [ ] Utwórz `data/realizacje.json` jako jedyne źródło prawdy:

```json
[
  {
    "id": "szafa-pax-gliwice-2026-03",
    "tytul": "Montaż szafy PAX z drzwiami przesuwnymi",
    "miasto": "Gliwice",
    "kategoria": "sypialnia",
    "marka": "IKEA",
    "data": "2026-03-14",
    "czas": "3 godziny",
    "opis": "Szafa PAX 250 cm z drzwiami przesuwnymi Auli. Wyrównanie do nierównej ściany, montaż oświetlenia wewnętrznego.",
    "przed": "img/realizacje/szafa-pax-gliwice-przed",
    "po": "img/realizacje/szafa-pax-gliwice-po",
    "alt_przed": "Rozpakowane elementy szafy PAX przed montażem, mieszkanie w Gliwicach",
    "alt_po": "Zamontowana szafa PAX z drzwiami przesuwnymi w sypialni, Gliwice"
  }
]
```

- [ ] Nazewnictwo plików pod SEO: `montaz-szafy-pax-gliwice-01.jpg`, nie `IMG_2841.jpg`.
- [ ] Skrypt budujący miniatury (400px) i warianty (800/1200) z jednego źródła.

## 3.3 Interfejs

- [ ] Siatka kafelków (CSS Grid, `masonry` opcjonalnie), miniatury 400px, lazy loading.
- [ ] **Filtry:** kategoria (sypialnia / kuchnia / salon / łazienka / na ścianie / przeprowadzka), miasto, marka. Filtrowanie po stronie klienta — dane i tak są w JSON.
- [ ] **Lightbox** po kliknięciu: pełne zdjęcie, opis, nawigacja strzałkami, Esc zamyka, focus trap, `aria-modal="true"`.
- [ ] **Suwak przed/po** (before/after slider) — element o najwyższym „efekcie wow". Prosty `<input type="range">` sterujący `clip-path` górnej warstwy; bez bibliotek.
- [ ] Pod każdą realizacją: przycisk „Chcę podobny montaż" → prowadzi do formularza z prefilled kategorią.
- [ ] Sekcja „Ostatnie realizacje" na stronie głównej — 6 najnowszych kafelków, nad sekcją opinii.
- [ ] Osobna podstrona `/realizacje/` z pełną galerią + paginacja lub „załaduj więcej" po 12.

## 3.4 SEO galerii

- [ ] Dane strukturalne `ImageObject` dla każdego zdjęcia (`contentUrl`, `caption`, `datePublished`).
- [ ] Osobny `sitemap-images.xml` zgłoszony w Search Console.
- [ ] Podstrony realizacji per miasto: `/realizacje/gliwice/`, `/realizacje/zabrze/` — jeśli masz min. 5 realizacji z danego miasta. Inaczej cienka treść.
- [ ] Każde zdjęcie ma unikalny, opisowy `alt` zawierający usługę + miasto (bez upychania fraz).
- [ ] Te same zdjęcia wrzuć na wizytówkę Google (Faza 6) — Google premiuje aktywne profile ze świeżymi zdjęciami.

---

# FAZA 4 — OPINIE I KOMENTARZE `P1`

Dwa osobne systemy o różnym celu:
- **Opinie** (strona główna) — dowód społeczny, wpływa na konwersję
- **Komentarze** (pod artykułami bloga) — świeża treść generowana przez użytkowników, dłuższy czas na stronie, długi ogon fraz z pytań czytelników

## 4.1 Wybór architektury

Rekomendacja: **Supabase** (Postgres + RLS) — już go używasz w innych projektach, darmowy tier w zupełności wystarczy, nie wymaga własnego backendu.

- [ ] Załóż projekt Supabase (region: Frankfurt — RODO, bliskość).
- [ ] Zapisz `SUPABASE_URL` i `SUPABASE_ANON_KEY`. **Nigdy** nie umieszczaj `service_role` w kodzie frontu.

Alternatywy odrzucone i dlaczego: Disqus (reklamy, ciężki, spowolni stronę), Giscus (wymaga konta GitHub — twoi klienci go nie mają), własny backend PHP (więcej utrzymania niż korzyści).

## 4.2 Schemat bazy

- [ ] Tabela `opinie`:

```sql
create table opinie (
  id           uuid primary key default gen_random_uuid(),
  autor        text not null check (char_length(autor) between 2 and 60),
  miasto       text check (char_length(miasto) <= 40),
  ocena        smallint not null check (ocena between 1 and 5),
  tresc        text not null check (char_length(tresc) between 20 and 1500),
  status       text not null default 'oczekuje'
               check (status in ('oczekuje','zatwierdzona','odrzucona')),
  utworzono    timestamptz not null default now(),
  ip_hash      text,          -- SHA-256 z solą, NIE surowe IP
  honeypot_ok  boolean default true
);

create table komentarze (
  id           uuid primary key default gen_random_uuid(),
  artykul_slug text not null,
  autor        text not null check (char_length(autor) between 2 and 60),
  tresc        text not null check (char_length(tresc) between 5 and 2000),
  odpowiedz_na uuid references komentarze(id) on delete cascade,
  status       text not null default 'oczekuje'
               check (status in ('oczekuje','zatwierdzony','odrzucony')),
  utworzono    timestamptz not null default now(),
  ip_hash      text
);

create index on komentarze (artykul_slug, status, utworzono desc);
create index on opinie (status, utworzono desc);
```

- [ ] Włącz RLS na obu tabelach.
- [ ] Polityka SELECT: publiczny odczyt **tylko** rekordów ze statusem zatwierdzonym.
- [ ] Polityka INSERT: publiczny zapis, ale wymuszony `status = 'oczekuje'` (kolumna z domyślną wartością + polityka `with check (status = 'oczekuje')`).
- [ ] Brak polityki UPDATE/DELETE dla roli anon — moderacja tylko przez zalogowanego admina.

## 4.3 Antyspam (obowiązkowo — inaczej w 2 tygodnie masz zaśmiecone)

- [ ] **Honeypot:** ukryte pole `strona_www`; jeśli wypełnione → cicho odrzuć.
- [ ] **Time trap:** odrzuć wysyłkę szybszą niż 3 s od załadowania formularza.
- [ ] **Cloudflare Turnstile** (darmowy, bez uciążliwych zagadek, przyjazny RODO — lepszy wybór niż reCAPTCHA).
- [ ] **Rate limit:** max 3 wpisy na godzinę z jednego `ip_hash` — Edge Function albo funkcja SQL sprawdzająca przed insertem.
- [ ] Filtr słów kluczowych spamu i linków — komentarz zawierający `http` trafia automatycznie do kolejki lub jest odrzucany.
- [ ] `rel="ugc nofollow"` na wszystkich linkach w treściach użytkowników (jeśli w ogóle dopuszczasz).

## 4.4 Moderacja

- [ ] Panel `/admin/` chroniony logowaniem Supabase (magic link na Twój e-mail).
- [ ] Lista oczekujących z przyciskami: zatwierdź / odrzuć / usuń.
- [ ] Powiadomienie e-mail o nowym wpisie (Supabase Database Webhook → Resend/SMTP).
- [ ] **Zasada:** nic nie publikuje się automatycznie. Wszystko przechodzi przez Ciebie.

## 4.5 RODO

- [ ] Checkbox zgody przy formularzu: *„Wyrażam zgodę na publikację mojego imienia i treści opinii na stronie meblofix-gliwice.pl"* — niezaznaczony domyślnie.
- [ ] Nie zbieraj e-maili, jeśli nie są potrzebne. Jeśli zbierasz — nie publikuj ich.
- [ ] Przechowuj **hash IP z solą**, nie surowe IP. Uzasadnienie: bezpieczeństwo/antyspam (uzasadniony interes).
- [ ] Podstrona **Polityka prywatności** — jeśli jej nie ma, dopisz: kto administruje danymi, jakie dane, po co, jak długo, prawo do usunięcia, kontakt.
- [ ] Link „Usuń mój komentarz" → prosty e-mail kontaktowy w polityce.

## 4.6 Frontend

- [ ] Opinie: renderuj z Supabase, ale **z fallbackiem statycznym** (patrz 0.3) — strona nigdy nie może zależeć od dostępności API.
- [ ] Komentarze pod każdym artykułem: lista + formularz + licznik („12 komentarzy").
- [ ] Odpowiedzi jednopoziomowe (`odpowiedz_na`) — głębsze zagnieżdżenie to koszmar na telefonie.
- [ ] Po wysłaniu: komunikat *„Dziękuję! Komentarz pojawi się po sprawdzeniu — zwykle w ciągu kilku godzin."*
- [ ] Ładowanie komentarzy **leniwe** (IntersectionObserver, dopiero gdy użytkownik dojedzie do sekcji) — nie obciąża LCP.

## 4.7 Dane strukturalne — uwaga

- [ ] **Nie** dodawaj `aggregateRating` opartego na opiniach z własnej strony. Google nie wyświetla samodzielnie zebranych ocen dla firm lokalnych i może to potraktować jako nadużycie. Ocena „5.0" ma zostać elementem wizualnym, nie schematem.
- [ ] Zamiast tego zadbaj o **opinie w wizytówce Google** (Faza 6) — te faktycznie pokazują gwiazdki w wynikach.
- [ ] Możesz dodać `Comment` / `commentCount` do schematu `BlogPosting` — to jest bezpieczne.

---

# FAZA 5 — TREŚĆ I SEO: SILNIK RUCHU `P2`

To jest ta część, która realnie buduje odwiedziny. Reszta to fundamenty.

## 5.1 Naprawa kanibalizacji

- [ ] Strona główna zawiera pełne teksty artykułów, które istnieją też jako podstrony `/blog/...`. Zamień je na **kafelki z zajawką 2–3 zdania + link**.
- [ ] Zysk podwójny: Google przestaje wybierać między dwiema stronami na tę samą frazę, a strona główna drastycznie się odchudza.
- [ ] Sprawdź w Search Console → Wyniki wyszukiwania → filtr po zapytaniu: czy dla tych fraz rankuje strona główna czy podstrona. Jeśli główna — to potwierdzenie problemu.

## 5.2 Ujednolicenie technicznego SEO

- [ ] Podstrona bloga ma tylko `description` i `canonical`; strona główna ma komplet (OG, Twitter, geo). **Zrób jeden szablon `<head>` dla wszystkich podstron.**
- [ ] Każda podstrona: unikalny `title` (≤60 zn.) i `description` (≤155 zn.), OG image, `robots`, canonical.
- [ ] Ujednolic trailing slash (wybierz jedną wersję, przekierowania 301 z drugiej).
- [ ] Zaktualizuj `sitemap.xml` (wszystkie podstrony + `lastmod`), zgłoś w Search Console.
- [ ] `robots.txt` z linkiem do sitemapy.
- [ ] Dane strukturalne: `LocalBusiness` (NAP, godziny, `areaServed`, `priceRange`), `FAQPage` dla sekcji FAQ, `BlogPosting` dla artykułów, `BreadcrumbList` dla podstron.
- [ ] Test w Rich Results Test — zero błędów.
- [ ] Usuń `meta keywords` (~30 fraz) — Google to ignoruje od lat, tylko zaśmieca kod.
- [ ] **Zaktualizuj daty.** Artykuły datowane „Grudzień 2024 / Luty 2025", stopka „© 2025". Mamy lipiec 2026 — strona wygląda na porzuconą. Rok w stopce → dynamiczny.

## 5.3 Rozbudowa podstron lokalnych

Masz 5 miast. Dodaj kolejne — ale **każda podstrona musi mieć unikalną treść**, nie podmienioną nazwę miasta (Google wykrywa doorway pages).

- [ ] `/montaz-mebli-tychy/`
- [ ] `/montaz-mebli-chorzow/`
- [ ] `/montaz-mebli-mikolow/`
- [ ] `/montaz-mebli-knurow/`
- [ ] `/montaz-mebli-pyskowice/`

Wzorzec unikalnej treści dla każdej: dzielnice/osiedla obsługiwane, czas dojazdu z Gliwic, koszt dojazdu, 2–3 realizacje z tego miasta (z galerii!), opinia klienta stamtąd, lokalne odniesienia (np. „nowe bloki na osiedlu X — często montujemy tam zabudowy kuchenne").

- [ ] Każda podstrona lokalna linkuje do galerii przefiltrowanej po tym mieście.

## 5.4 Podstrony usługowe (nowa oś ruchu)

Obok podziału geograficznego zbuduj podział usługowy — to nowe frazy, których dziś nie łapiesz:

- [ ] `/montaz-kuchni-gliwice/` — zabudowy METOD/SEKTION, blaty, AGD, cargo
- [ ] `/montaz-szafy-przesuwnej-gliwice/` — PAX, Komandor, szafy wnękowe
- [ ] `/wieszanie-telewizora-gliwice/` — uchwyty, kołki, karton-gips, maskowanie kabli
- [ ] `/montaz-mebli-biurowych-gliwice/` — biura, coworkingi, faktura VAT
- [ ] `/demontaz-i-przeprowadzki-gliwice/`
- [ ] `/naprawa-i-regulacja-mebli-gliwice/` — zawiasy, szuflady, prowadnice

## 5.5 Kalendarz treści — 12 tygodni

Zasada: **1 artykuł tygodniowo, min. 900 słów, odpowiadający na realne pytanie klienta.** Tematy z Twojej codziennej pracy — masz przewagę, której nie ma żadna agencja.

- [ ] T1 — „Ile kosztuje montaż mebli w Gliwicach? Cennik 2026 z przykładami"
- [ ] T2 — „Montaż szafy PAX krok po kroku — ile trwa i na co uważać"
- [ ] T3 — „Jakie kołki do karton-gipsu? Szafki wiszące bez ryzyka"
- [ ] T4 — „Jak wyregulować zawiasy w szafkach kuchennych — 3 osie regulacji"
- [ ] T5 — „Brakuje części w zestawie IKEA — co zrobić krok po kroku"
- [ ] T6 — „Montaż kuchni IKEA METOD — czego nie ma w instrukcji"
- [ ] T7 — „Meble z OLX — czy warto, jak przewieźć i złożyć"
- [ ] T8 — „Szuflady się nie domykają — diagnostyka i naprawa"
- [ ] T9 — „Montaż mebli w wynajmowanym mieszkaniu — co wolno wiercić"
- [ ] T10 — „Wieszanie telewizora na ścianie — uchwyt, kołki, kable"
- [ ] T11 — „Przeprowadzka: które meble się rozkręca, a które nie"
- [ ] T12 — „Ile trwa montaż mebli? Realne czasy dla 15 typów mebli"

Dla każdego artykułu checklist publikacyjna:
- [ ] Unikalny `title` + `description`
- [ ] Min. 3 własne zdjęcia (nie stockowe!) z opisowym `alt`
- [ ] 2–3 linki wewnętrzne (do usługi, do miasta, do galerii)
- [ ] Sekcja FAQ na końcu (2–3 pytania) + `FAQPage` schema
- [ ] CTA na końcu z telefonem
- [ ] Włączone komentarze (Faza 4)
- [ ] Dodany do sitemapy

## 5.6 Linkowanie wewnętrzne

- [ ] Każdy artykuł → link do min. 1 podstrony usługowej i 1 lokalnej
- [ ] Każda podstrona lokalna → link do galerii z tego miasta + 2 artykuły
- [ ] Strona główna → linki do wszystkich podstron (masz już, sprawdź kompletność)
- [ ] Okruszki (breadcrumbs) na każdej podstronie

---

# FAZA 6 — WIZYTÓWKA GOOGLE I LOKALNE SEO `P2`

**Przy usługach lokalnych wizytówka Google generuje zwykle więcej telefonów niż sama strona.** Jeśli miałbyś zrobić tylko jedną rzecz z tego dokumentu poza Fazą 0 — to tę.

## 6.1 Google Business Profile

- [ ] Sprawdź, czy wizytówka istnieje i jest **zweryfikowana**. Jeśli nie — załóż i przejdź weryfikację.
- [ ] Kategoria główna: *Usługi montażowe* / *Stolarz*. Dodatkowe: *Usługi remontowe*, *Firma przeprowadzkowa*.
- [ ] Pełny opis (750 zn.) z naturalnymi frazami, bez upychania.
- [ ] Obszar działania: wszystkie obsługiwane miasta (działalność mobilna — bez adresu publicznego, jeśli pracujesz u klienta).
- [ ] Godziny otwarcia zgodne ze stroną (NAP musi się zgadzać co do znaku).
- [ ] Usługi z cenami — te same, co w cenniku na stronie.
- [ ] **Minimum 20 zdjęć** z galerii (Faza 3). Dodawaj 3–5 nowych miesięcznie.
- [ ] Sekcja Pytania i odpowiedzi — sam zadaj 5 najczęstszych pytań i sam odpowiedz.
- [ ] Link do strony w wizytówce z parametrem UTM (`?utm_source=gbp`) — będziesz wiedział, ile ruchu stąd idzie.

## 6.2 Zbieranie opinii Google (najważniejszy pojedynczy czynnik)

- [ ] Wygeneruj krótki link do wystawienia opinii (panel GBP → „Poproś o opinie").
- [ ] Wydrukuj **kod QR** z tym linkiem — zostawiaj wizytówkę po każdym zleceniu.
- [ ] Szablon SMS wysyłany 2 h po zakończeniu montażu:
      *„Dzień dobry, dziękuję za zlecenie. Jeśli wszystko gra, będę wdzięczny za krótką opinię: [link]. Zajmie 30 sekund. Pozdrawiam, MebloFix"*
- [ ] **Cel: 2–4 nowe opinie miesięcznie, systematycznie.** Regularność liczy się bardziej niż ilość.
- [ ] Odpowiadaj na **każdą** opinię w ciągu 24 h — Google to premiuje.
- [ ] Nigdy nie kupuj opinii. Wykrycie = zawieszenie wizytówki.

## 6.3 Katalogi i cytowania NAP

Nazwa, adres i telefon muszą być **identyczne** wszędzie.

- [ ] Panorama Firm
- [ ] PKT.pl
- [ ] Oferteo
- [ ] Fixly
- [ ] Aleo
- [ ] Targeo
- [ ] Bing Places
- [ ] Apple Business Connect
- [ ] Lokalne grupy na Facebooku (Gliwice, Zabrze — ogłoszenia usługowe, bez spamu)

## 6.4 Kanały dodatkowe

- [ ] Profil Facebook z galerią realizacji — publikuj 2× w tygodniu (te same zdjęcia, co na stronie)
- [ ] Ewentualnie Instagram — montaż to wdzięczny materiał wizualny (przed/po, timelapse)
- [ ] Odpowiadaj na zapytania w lokalnych grupach — to najtańsze źródło pierwszych zleceń

---

# FAZA 7 — ANALITYKA I POMIAR `P2`

Bez pomiaru nie wiesz, co działa.

- [ ] **Netlify Analytics** (płatne, ~9 USD/mies.) — dane z logów serwera, bez skryptu i bez cookies, więc bez banera zgód i bez wpływu na wydajność. Najprostsza opcja przy tym hostingu.
- [ ] Alternatywa darmowa: **GA4** — pełne lejki i zdarzenia, ale wraca obowiązek banera cookies i dokłada skryptu do strony.
- [ ] Niezależnie od wyboru: **Google Search Console** jest obowiązkowe i darmowe. Jeśli masz budżet zero, zacznij od samego GSC + GA4.
- [ ] Podepnij **Google Search Console** (jeśli jeszcze nie) i zgłoś sitemapę.
- [ ] Śledź zdarzenia konwersji:
      - [ ] kliknięcie w numer telefonu (`tel:`)
      - [ ] kliknięcie WhatsApp
      - [ ] wysłanie formularza
      - [ ] kliknięcie w galerię / lightbox
      - [ ] dodanie opinii/komentarza
- [ ] Zapisz **baseline** (dzisiejsze liczby) w tabeli poniżej — bez punktu odniesienia nie ocenisz postępu.
- [ ] Ustaw comiesięczny przegląd: 30 min raz w miesiącu, Search Console → które frazy rosną, które podstrony nie generują wejść.

| Metryka | Baseline (data: ____) | Cel +3 mies. | Cel +6 mies. |
|---|---|---|---|
| Wyświetlenia w Search Console | | ×2 | ×4 |
| Kliknięcia z wyszukiwarki | | ×2 | ×4 |
| Telefony z wizytówki Google | | | |
| Opinie Google (liczba) | | +8 | +18 |
| Kliknięcia `tel:` na stronie | | | |
| Wysłane formularze | | | |
| Zaindeksowane podstrony | | | |

---

# FAZA 8 — KONWERSJA `P3`

Ruch bez konwersji to strata. Te punkty zamieniają odwiedziny w telefony.

- [ ] **Sticky pasek na mobile** z przyciskiem „Zadzwoń" i „WhatsApp" — zawsze widoczny na dole ekranu.
- [ ] Link WhatsApp z gotową treścią: `https://wa.me/48784878197?text=Dzie%C5%84%20dobry%2C%20chc%C4%99%20wycen%C4%99%20monta%C5%BCu`
- [ ] **Kalkulator wyceny** — interaktywny widget: wybierasz typ mebla i ilość, dostajesz orientacyjny przedział. Świetnie działa na czas spędzony na stronie i naturalnie zbiera zapytania.
- [ ] Formularz: możliwość **dołączenia zdjęcia** mebla/paczki — realnie skraca wycenę i podnosi liczbę zgłoszeń.
- [ ] Konkretna obietnica czasu odpowiedzi zamiast „odpowiadam w kilka minut" → np. „Odpowiadam do 30 minut w godz. 8–20".
- [ ] **Ujednolic narrację.** Teraz raz „lokalny montażysta… specjalizuję się", raz „Składamy szafy PAX… Obsługujemy klientów". Wybierz **„ja"** — przy jednoosobowej działalności buduje więcej zaufania niż korporacyjne „my".
- [ ] Sekcja „Jak wygląda współpraca" — 4 kroki: telefon → wycena → termin → montaż. Zdejmuje niepewność.
- [ ] Widoczna informacja o fakturze VAT (klienci firmowi to lepsze stawki).

---

# FAZA 9 — MEBLE NA WYMIAR: NOWA LINIA BIZNESOWA `P3`

To nie jest rozbudowa strony — to nowy biznes, który dopiero na końcu dostaje stronę. Kolejność ma znaczenie: **najpierw decyzje i pierwsze realizacje, dopiero potem kod.** Strona reklamująca usługę, której jeszcze nie umiesz wycenić i dostarczyć, generuje telefony, które musisz odrzucać — a to kosztuje reputację.

## 9.1 Decyzje biznesowe (przed jakimkolwiek kodem)

- [ ] **Forma prawna.** Ustal z księgową, czy zostajesz przy dotychczasowej formie, czy potrzebna rejestracja/rozszerzenie. Sprzedaż mebli konsumentowi to inna sytuacja niż usługa montażu: dochodzi rękojmia (2 lata), obowiązki informacyjne, faktury. Limit działalności nierejestrowanej sprawdź na aktualny rok — zmienia się co roku wraz z płacą minimalną.
- [ ] **Kody PKD.** Dopisz właściwe dla produkcji mebli (m.in. produkcja mebli kuchennych i pozostałych mebli). Do potwierdzenia z księgową.
- [ ] **Model produkcji.** Rekomendacja na start: **nie kupuj piły formatowej.** Zamawiaj formatki w hurtowni płyt z usługą cięcia i oklejania (Śląsk ma tego pod dostatkiem), a sam robisz projekt, wiercenie, okucia i montaż u klienta. Marża niższa, ale wejście kosztuje tysiące zamiast dziesiątek tysięcy, a Ty i tak masz przewagę w montażu.
- [ ] **Zakres startowy.** Zacznij od **szaf wnękowych i zabudów** — najprostsza geometria, najmniej okuć, najwyższa marża względem trudności. Kuchnie dopiero po kilkunastu realizacjach (blaty, AGD, cargo, fronty lakierowane = dużo więcej rzeczy do zepsucia).
- [ ] **Dostawcy.** Wybierz i przetestuj: hurtownia płyt z formatowaniem, dostawca okuć (Blum/Hettich/GTV), dostawca frontów. Zbierz cenniki — bez nich nie wycenisz.
- [ ] **Ubezpieczenie OC** działalności — przy wierceniu w cudzych mieszkaniach i meblach za kilka tysięcy to nie jest opcja.

## 9.2 Gdzie to umieścić: podstrona czy osobna marka?

**Rekomendacja: na start jako wyraźnie wydzielony dział na meblofix-gliwice.pl, nie osobna domena.**

Za tym rozwiązaniem:
- domena jest już zaindeksowana, ma SEO 100/100 i historię — nowa startuje od zera i potrzebuje 6–12 miesięcy
- masz gotową bazę klientów montażowych, którzy są naturalną grupą docelową („skoro składasz meble, to zrobisz mi szafę do wnęki?")
- jedna wizytówka Google, jedna analityka, jedno utrzymanie

Ryzyko, które trzeba zneutralizować:
- [ ] „od 80 zł" w nagłówku kotwiczy cenowo. Klient szafy za 6 000 zł nie może trafić na komunikat handyman-owy. **Na podstronach „na wymiar" nie pokazuj cennika montażu** — osobny nagłówek, osobna estetyka, osobny formularz.
- [ ] Osobna sekcja w menu, nie pozycja w liście usług montażowych.

**Kiedy wydzielić osobną domenę:** gdy meble na wymiar dają ponad połowę przychodu i masz min. 15 realizacji z dobrymi zdjęciami. Wtedy przeprowadzka ma sens i możesz przenieść moc linkami. Nie wcześniej.

## 9.3 Zanim powstanie strona — materiał

- [ ] Wykonaj **3–5 realizacji** na próbę: dla siebie, rodziny, znajomych, po kosztach materiału. Cel to nie zarobek, tylko zdjęcia, przećwiczenie procesu i realne pomiary czasu.
- [ ] Zmierz, ile faktycznie zajmuje: pomiar, projekt, zamówienie formatek, montaż. Bez tego nie wycenisz i nie obiecasz terminu.
- [ ] Zbuduj **widełki cenowe** dla typowych konfiguracji (szafa 200 cm, 250 cm, 300 cm; z drzwiami przesuwnymi / uchylnymi; garderoba wnękowa).
- [ ] Zdjęcia: **przed** (pusta wnęka) i **po** — dokładnie ten sam kadr, statyw lub oznaczone miejsce. To materiał na suwak przed/po z Fazy 3.
- [ ] Opisz **proces w 5 krokach** — to najważniejszy tekst na całej podstronie, bo klient kupuje pewność, nie meble: bezpłatny pomiar → projekt i wizualizacja → wycena i zaliczka → produkcja → montaż i regulacja.
- [ ] Ustal **gwarancję** i zapisz ją wprost (np. 24 miesiące na wykonanie i okucia).

## 9.4 Struktura na stronie

- [ ] `/meble-na-wymiar/` — strona-hub działu, z procesem, galerią i formularzem
- [ ] `/szafy-wnekowe-na-wymiar-gliwice/`
- [ ] `/garderoby-na-wymiar-gliwice/`
- [ ] `/zabudowy-kuchenne-na-wymiar-gliwice/` — dopiero gdy realnie je robisz
- [ ] `/meble-lazienkowe-na-wymiar-gliwice/`
- [ ] `/meble-biurowe-na-wymiar-gliwice/`
- [ ] Nowa kategoria w galerii (Faza 3): `"na-wymiar"` + filtr
- [ ] **Osobny formularz zapytania**, inny niż montażowy — pola: pomieszczenie, przybliżone wymiary (szer./wys./gł.), typ drzwi, termin, przedział budżetu, załącznik ze zdjęciem wnęki
- [ ] Sekcja „Ile to kosztuje" z uczciwymi widełkami i wyjaśnieniem, co je zmienia. Ukrywanie cen odstrasza; podanie przedziału filtruje klientów, którzy i tak by nie kupili.
- [ ] Dedykowane FAQ: czas realizacji, zaliczka, czy robisz projekt przed wyceną, jakie płyty, czy można zobaczyć próbki, co z nierównymi ścianami
- [ ] `Service` / `Product` w danych strukturalnych dla podstron usługowych

## 9.5 Wykorzystaj to, co już masz — kalkulator formatek

Masz aplikację `formatki-meblowe`. To realny wyróżnik, którego nie ma żadna lokalna konkurencja:

- [ ] **Publiczny kalkulator wyceny szafy** na stronie: klient podaje wymiary wnęki i liczbę półek/drążków → dostaje orientacyjną cenę i podgląd. Silnik już masz.
- [ ] Efekt uboczny: taki widget mocno podnosi czas na stronie i naturalnie zbiera zapytania (żeby zobaczyć pełną wycenę → zostaw kontakt).
- [ ] Drugi efekt: to jest treść, do której inni linkują. Najtańszy sposób na zdobycie linków zwrotnych w tej branży.
- [ ] Wewnętrznie: ta sama wycena eksportuje listę formatek do zamówienia w hurtowni. Jedno źródło danych od zapytania klienta do cięcia płyty.

## 9.6 Treści pod nową linię (dopisz do kalendarza z Fazy 5)

Frazy „na wymiar" są bardziej konkurencyjne, ale klient jest wart 20–50× więcej niż przy montażu. Warto.

- [ ] „Ile kosztuje szafa wnękowa na wymiar? Ceny 2026 na Śląsku"
- [ ] „Szafa na wymiar czy IKEA PAX — kiedy co się opłaca"
- [ ] „Jak zmierzyć wnękę pod szafę — instrukcja krok po kroku"
- [ ] „Drzwi przesuwne czy uchylne — wady i zalety w praktyce"
- [ ] „Jaka płyta na meble? Laminat, MDF, fornir — czym się różnią"
- [ ] „Garderoba we wnęce — ile miejsca naprawdę potrzebujesz"
- [ ] „Nierówne ściany i skosy — jak się robi meble w starym budownictwie"
- [ ] „Ile trwa wykonanie mebli na wymiar — realny harmonogram"

## 9.7 Wizytówka i lokalne

- [ ] Dopisz usługi „meble na wymiar", „szafy wnękowe", „zabudowy" do istniejącej wizytówki Google (nie zakładaj drugiej — Google dopuszcza jeden profil na firmę w jednej lokalizacji).
- [ ] Rozważ dodanie kategorii dodatkowej *Producent mebli* / *Sklep z meblami na wymiar*.
- [ ] Zdjęcia realizacji „na wymiar" do wizytówki — te robią największe wrażenie.

---

# ANEKS — CO CLAUDE CODE ZROBI SAM, A CO WYMAGA CIEBIE

## A. Może zrobić autonomicznie (przy dobrym opisie zadania)

- [ ] Owinięcie wszystkich `fetch` w timeouty i obsługę błędów
- [ ] Usunięcie licznika, naprawa `href="#"`, statyczny fallback opinii
- [ ] Poprawki dostępności: `aria-*`, `label`, skip link, hierarchia nagłówków, focus
- [ ] Konwersja obrazów, generowanie wariantów, `<picture>`, lazy loading, `width`/`height`
- [ ] Cała galeria: struktura JSON, siatka, filtry, lightbox, suwak przed/po
- [ ] Komentarze i opinie: schemat SQL, polityki RLS, formularze, panel moderacji, antyspam
- [ ] Skrócenie artykułów na stronie głównej do zajawek
- [ ] Szablon `<head>`, dane strukturalne, sitemapy, `robots.txt`
- [ ] Szkielety nowych podstron lokalnych i usługowych
- [ ] Kalkulator wyceny (integracja z silnikiem formatek)
- [ ] Sticky pasek mobilny, ujednolicenie narracji w tekstach

## B. Może przygotować, ale Ty musisz zatwierdzić lub uzupełnić

- [ ] Diagnostyka PSI — Claude Code nie ma dostępu do panelu Cloudflare ani Search Console. Przełączniki z 0.2 klikasz Ty; Claude Code może zinterpretować wyniki.
- [ ] Treści artykułów — wygeneruje dobry szkielet, ale wartość mają Twoje obserwacje z realnych zleceń. Tekst bez nich będzie brzmiał jak każdy inny blog w branży i nie da przewagi.
- [ ] Cenniki i widełki — musisz podać liczby.
- [ ] Deploy na produkcję — ustaw tak, żeby wymagał Twojej akceptacji.

## C. Nie zrobi w ogóle

- [ ] Zdjęcia realizacji — to musi być Twój aparat i Twoje zlecenia
- [ ] Weryfikacja wizytówki Google (kod pocztowy/telefon)
- [ ] Zbieranie prawdziwych opinii od klientów
- [ ] Rejestracja działalności, umowy z hurtowniami, ubezpieczenie
- [ ] Decyzje: co robisz, za ile, dla kogo
- [ ] Fizyczne wykonanie pierwszych mebli na wymiar

## D. Zasady bezpiecznej pracy z agentem na żywej stronie

- [ ] **Git od pierwszej minuty.** Jeśli repo jeszcze nie istnieje — załóż przed czymkolwiek innym.
- [ ] Praca na **branchach**, nigdy bezpośrednio na `main`.
- [ ] Cloudflare Pages: włącz **preview deployments** dla branchy. Każdą zmianę oglądasz na podglądzie przed merge'em.
- [ ] Po każdej fazie: commit z czytelnym opisem + odhaczenie punktów w tym pliku.
- [ ] **Jedna faza = jedna sesja.** Nie każ agentowi robić „wszystkiego naraz" — kontekst się rozjeżdża, a Ty tracisz kontrolę nad tym, co się zmieniło.
- [ ] Po każdej sesji: PSI + szybki przegląd strony w przeglądarce. Regresje wychodzą najszybciej właśnie tam.
- [ ] Trzymaj `CLAUDE.md` w repo strony z kontekstem projektu (stack, konwencje, czego nie ruszać).

---

# HARMONOGRAM

| Tydzień | Zakres |
|---|---|
| 1 | Faza 0 (całość) + weryfikacja PSI |
| 2 | Faza 1 (dostępność) + Faza 2.1 (obrazy) |
| 3 | Faza 6.1–6.2 (wizytówka Google + start zbierania opinii) ← **nie odkładaj** |
| 4 | Faza 3 (galeria — zbiórka materiału i struktura) |
| 5 | Faza 3 (galeria — interfejs i SEO) |
| 6 | Faza 4 (opinie i komentarze — baza, antyspam, moderacja) |
| 7 | Faza 4 (frontend) + Faza 7 (analityka, baseline) |
| 8 | Faza 5.1–5.2 (kanibalizacja, techniczne SEO) |
| 9–12 | Faza 5.3–5.4 (nowe podstrony) + start kalendarza treści |
| 13+ | 1 artykuł/tydzień, 3–5 zdjęć/miesiąc do GBP, 2–4 opinie/miesiąc |

**Uwaga o Fazie 6:** wizytówka Google jest w harmonogramie w tygodniu 3, choć formalnie ma priorytet P2. Powód: efekty w lokalnym SEO narastają miesiącami, więc im wcześniej ruszy, tym lepiej — a wymaga najmniej pracy technicznej.

---

# DEFINICJA UKOŃCZENIA

Etap uznajemy za zamknięty, gdy:

- [ ] PSI zwraca wynik liczbowy: mobile ≥ 75, desktop ≥ 90
- [ ] Dostępność ≥ 95, SEO = 100, Praktyki ≥ 95
- [ ] Zero błędów w konsoli na wszystkich podstronach
- [ ] Search Console: zero błędów indeksowania, Core Web Vitals bez adresów „Słabe"
- [ ] Galeria: min. 20 realizacji z filtrami i lightboxem
- [ ] Opinie i komentarze działają, z moderacją i antyspamem
- [ ] Wizytówka Google zweryfikowana, 20+ zdjęć, systematyczny napływ opinii
- [ ] Analityka mierzy wszystkie zdarzenia konwersji
- [ ] Min. 12 artykułów na blogu, 10 podstron lokalnych, 6 usługowych

---

# NOTATKI ROBOCZE

> Miejsce na wnioski z diagnostyki, znalezione błędy, decyzje.

**Znaleziska z inspekcji 30.07.2026:**
- Serwer odpowiada poprawnie — scenariusz „serwer nie żył podczas testu" mało prawdopodobny
- Dwa wiszące zapytania: opinie + licznik odwiedzin → główna hipoteza błędu PSI
- Przycisk hero i przycisk telefonu w nawigacji mają `href="#"`
- Link do Google Maps prawie na pewno nieprawidłowy
- Strona główna zawiera pełne teksty 3 artykułów istniejących też jako podstrony
- Podstrona bloga ma szczątkowe metadane w porównaniu ze stroną główną
- Daty treści zatrzymane na 2025

**Potwierdzone:**
- Hosting to **Netlify**, nie Cloudflare (nagłówki: `server: Netlify`, `x-nf-request-id`, brak `cf-ray`). Cloudflare co najwyżej jako DNS bez proxy.
- Żywe źródło strony: `~/projekty/Meblofix stary projekt netlify/index.html` — zawiera oba znaczniki kontrolne. Mimo nazwy to katalog roboczy.
- Repo: `github.com/Twoja-chwila/Twoja-chwila-Meblofix-Gliwice`, ostatni commit 09.06.2026 („Wymuszenie redeploy Netlify")
- `~/projekty/meblofix/` = porzucony szkielet Astro, do usunięcia
- `~/projekty/meblofix nowy projekt/` = osobny, niewdrożony projekt z panelem admina — ustalić status przed rozpoczęciem prac
- Lokalny `robots.txt` (poprawny: `Allow: /` + sitemapa) jest **untracked** → prawdopodobnie nigdy nie wdrożony
- Brak `netlify.toml` → brak konfiguracji nagłówków i cache
- Meble na wymiar: linia biznesowa jeszcze nie istnieje → Faza 9 zaczyna się od decyzji, nie od kodu

**Do ustalenia:**
- [ ] Czy `robots.txt` i `sitemap.xml` istnieją na produkcji?
- [ ] Co zawiera „meblofix nowy projekt" — przepisywana wersja strony czy osobne narzędzie?
- [ ] Gdzie trafiają zgłoszenia z formularza?
- [ ] Dlaczego 09.06.2026 trzeba było wymuszać redeploy?
- [ ] Czy istnieje zweryfikowana wizytówka Google?
- [ ] Czy w kodzie jest JSON-LD `LocalBusiness` i `aggregateRating`?
