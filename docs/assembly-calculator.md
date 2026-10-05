# Kalkulator oparty na czasie montażu

Cena mebli jest informacją o zakupie. Nie wpływa na czas ani cenę montażu.
API i interfejs pokazują osobno czas producenta na sztukę, czas dla całej
pozycji, sumę potwierdzonych deklaracji, planowany czas pracy ekipy i widełki
kosztu. Suma niepełna ma oznaczenie liczby potwierdzonych sztuk.

## Wiarygodny czas producenta

`functions/api/assembly-time.js` akceptuje dwa rodzaje dowodu:

1. Wybrany `Product` w JSON-LD oficjalnej strony producenta. `url` musi
   odpowiadać końcowemu URL pobranego produktu, nazwa musi odpowiadać produktowi,
   a `brand`/`manufacturer` musi odpowiadać dozwolonej domenie. `additionalProperty`
   musi zawierać jednoznaczny `Czas montażu` albo `Assembly time` z jednostką.
   Liczbę osób odczytuje z `Liczba osób do montażu` albo `Assembly people`.
   Obsługiwane są minuty, godziny, zakresy i ISO PT (także unitCode MMT/HUR).
2. Ręcznie zweryfikowany wpis w `data/assembly-times.json` wiążący dokładny
   URL produktu z instrukcją na oficjalnej domenie producenta. Wpis musi zawierać
   `productUrl`, `productId`, `model`, `manufacturer`, `sourceUrl`, `verifiedAt`
   (ISO UTC), `evidence` (odczytany fragment lub opis strony/piktogramu),
   `minutesMin`, `minutesMax` i `people` (liczba całkowita 1–10 albo null, gdy nie podano).
   Brak dowodu, duplikat, przyszła data, wpis starszy niż 180 dni lub zmiana
   docelowego produktu przy przekierowaniu wyłączają ten wpis.

Domeny źródeł kontroluje tabela `manufacturers` w tym samym pliku. Nowy
producent wymaga sprawdzenia jego oficjalnej domeny. Nie dodawaj domen
sprzedawców, wyszukiwarek, prywatnych adresów ani skracaczy linków.
Parametry wariantu i Allegro offerId pozostają w kluczu; usuwane są tylko
znane parametry śledzące. Nie dopasowujemy po podobieństwie nazwy.

Katalog początkowo jest pusty: nie potwierdzono żadnego konkretnego modelu
w tej zmianie. PDF-y nie są automatycznie pobierane ani interpretowane
w Workerze; ich czas można dodać dopiero po sprawdzeniu dokładnego modelu,
wariantu i instrukcji, wraz z dowodem w katalogu. Zmiana nie zapewnia odczytu
czasu z każdego układu HTML/PDF. Brak odczytu oznacza „niepotwierdzony”,
a nie stwierdzenie, że producent nigdy nie publikował czasu.
Dane z Agaty/Allegro, opis sprzedawcy, opinie i rekomendowane produkty nie są
przyjmowane jako deklaracja producenta.

## Planowany czas roboczy i bezpieczny fallback

Reguły w `data/cennik.json` są **wstępnymi założeniami planistycznymi Meblofix**,
nie deklaracjami producentów ani estymatorem skalibrowanym historią zleceń.
Wynik wymaga potwierdzenia instrukcji, zakresu, warunków i wyposażenia.

Przy potwierdzonym czasie i składzie 1–2 osób dolna granica na sztukę to
czas producenta + 15 min obsługi paczek. Górna to 1,25 × czas producenta
+ 15 min. Do całego zlecenia dodajemy raz 15 min przygotowania.
Nie dzielimy czasu przez liczbę osób i nie zakładamy przyspieszenia
przy przejściu na dwuosobową ekipę. Dla mieszanej listy stosujemy największy
wymagany skład ekipy do całego zlecenia; to konserwatywne założenie planu.

Gdy nie potwierdzono czasu/składu producenta, pojedyncza rozpoznana kategoria
może otrzymać poniższe jawnie oznaczone widełki. Są konfigurowalne:

| Kategoria | Minuty / szt. | Ekipa |
| --- | --- | --- |
| Szafka nocna | 30–60 | 1 |
| Szafa | 180–360 | 2 |
| Łóżko / leżanka | 90–180 | 2 |
| Komoda | 120–240 | 1 |
| Regał | 60–120 | 1 |
| Biurko | 60–120 | 1 |
| Stół / stolik | 30–60 | 1 |
| Krzesło | 20–45 | 1 |

Sprzeczne deklaracje i deklaracja wymagająca ponad dwóch osób zawsze
prowadzą do wyceny ręcznej. Brak jednoznacznej kategorii, kuchnia, zestaw, wariant narożny/przesuwny,
PAX/METOD/moduły bez wystarczających danych prowadzą do wyceny ręcznej.
Potwierdzona deklaracja o dokładnym produkcie i liczbie osób może posłużyć
do planu pracy tej bryły. Kontekst „Kuchnia”/„Zestaw mebli” zawsze wymaga
ręcznego potwierdzenia pełnego zakresu, także gdy znany jest czas samych brył.
Nie podajemy kwoty całego zlecenia, gdy choć jedna pozycja ma nieustalony
czas roboczy. Nadal pokazujemy znane deklaracje producenta.

## Koszt i kontrakt API

Dla każdej granicy kosztu:

`max(minimumJob, czas_ekipy_w_minutach / 60 × stawka_ekipy)`

Stawki pochodzą ze wspólnego cennika: 100 zł/h (1 monter), 180 zł/h (2),
minimum 150 zł. Osobno doliczamy dotychczasowe usługi dodatkowe i dojazd.
Czas dodatkowych usług oraz przejazdu nie jest ujęty w czasie montażu brył.

`quote.manufacturer` zawiera `complete`, `confirmedUnits`, `totalUnits`,
`minutesMin`, `minutesMax`. Gdy nie ma żadnego potwierdzenia, minuty są null.
`products[].assembly` zawiera dowód producenta, sumę pozycji i oddzielny
szacunek roboczy. `quote.working` podaje minuty, skład ekipy i stawkę.
`installationMin/Max` i `totalMin/Max` są granicami wyniku. Dotychczasowe
`installation` i `total` zachowują górną granicę dla zgodności kontraktu;
interfejs i powiadomienia pokazują obie granice.

Dla wyceny ręcznej `requiresManualQuote=true`, `pricingBasis=manual`,
`working`, kwoty robocizny i kwoty końcowe są null. `allConfirmed` nadal
odnosi się tylko do potwierdzenia cen zakupowych. Token obejmuje pełne
czasy i źródła; klient nie może zmienić czasów, stawek ani kwot w podpisanym
wyniku. Powiadomienie wyraźnie wskazuje potrzebę wyceny ręcznej.

## Weryfikacja

```sh
npm ci
npm run test:quote
npm run build:cloudflare
bash scripts/check-cloudflare-dist.sh
git diff --check
```

Testy używają syntetycznych deklaracji i nie dowodzą publikowania czasu
przez rzeczywiste produkty. Sprawdzają jednostki, wiązanie produktu i źródła,
konflikty, sumę pięciu sztuk, brak czasu/składu, fallback, wycenę ręczną,
niezależność kosztu od ceny mebla, obliczenia stawek i dodatków, podpisy oraz
prezentację w interfejsie i powiadomieniach. Osobny workflow PR wykonuje te
same testy i budowę bez wdrażania produkcji.
