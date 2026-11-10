# INSTRUKCJA KOMPLEKSOWEGO TESTOWANIA PLATFORMY NNAPER ORAZ ANKIETA DLA TESTERA

Dokument przeznaczony dla osoby testującej aplikację **NNAPER** (`http://localhost:8080/maps/map.html` lub `http://localhost:8000/maps/map.html`).
Celem badania jest:
1. Przeklikanie i zweryfikowanie każdego aspektu funkcjonalnego strony krok po kroku.
2. Ocena wizualna, estetyczna i użytecznościowa (UX/UI) poszczególnych elementów, nazw, ikon, kontrastów i układów paneli.
3. Zebranie szczegółowych odpowiedzi na pytania w Sekcji B, które tester odeśle po zakończeniu testów.

---

## SEKCJA A: SCENARIUSZ TESTOWY KROK PO KROKU (DO PRZEKLIKANIA)

Przed rozpoczęciem upewnij się, że aplikacja jest otwarta w przeglądarce pod adresem `http://localhost:8080/maps/map.html` (lub `http://localhost:8000/maps/map.html`), a okno przeglądarki ma pełny rozmiar.

---

### KROK 1: Nawigacja po mapie, chowanie paneli bocznych i wyszukiwarka adresów
1. **Przesuwanie i przybliżanie mapy**:
   * Przybliż mapę na obszar Trójmiasta (Gdańsk / Sopot / Gdynia) od widoku całego województwa aż do pojedynczych ulic i budynków (zoom 16–18).
   * Sprawdź, czy mapa działa płynnie i czy budynki, drogi, lasy, woda oraz etykiety ulic wyświetlają się wyraźnie.
2. **Uchwyty zwijania paneli bocznych ("ten cosiek")**:
   * Kliknij półokrągły uchwyt ze strzałką przy krawędzi **lewego panelu bocznego** — sprawdź, czy panel płynnie chowa się poza ekran i wysuwa z powrotem.
   * Kliknij przycisk **Planuj trasę** w lewym menu, aby otworzyć **prawy panel planowania trasy**.
   * Sprawdź, czy po lewej stronie prawego panelu planowania trasy również znajduje się analogiczny półokrągły uchwyt ze strzałką — kliknij go kilka razy i zweryfikuj, czy prawy panel chowa się i rozwija płynnie.
3. **Wyszukiwarka adresów (lewy górny róg mapy)**:
   * Wpisz w pole wyszukiwarki: `Gdańsk`, następnie `Grunwaldzka`, `Świętojańska Gdynia`, `Kościerzyna`.
   * Sprawdź, czy lista podpowiedzi pojawia się natychmiast i czy po kliknięciu w wynik kamera płynnie przelatuje w wybrane miejsce.

---

### KROK 2: Konto użytkownika, Statystyki konta i 4 skrajne punkty na mapie (N / S / E / W)
1. **Logowanie / Przełączanie profilu**:
   * W lewym panelu w sekcji konta sprawdź aktywnego użytkownika i profil (np. `default_user` lub własne konto z wgranymi śladami GPS).
   * Kliknij przycisk ustawień konta (ikona koła zębatego) i sprawdź, czy można zmienić nick, e-mail, hasło oraz wgrać avatar.
2. **Statystyki konta**:
   * Spójrz na kartę **STATYSTYKI KONTA** w lewym panelu i kliknij przycisk **Odśwież**.
   * Sprawdź, czy wartości:
     * `Max prędkość` (w km/h),
     * `Przejechane km`,
     * `Unikalne km`,
     * `Min / Max Lat` oraz `Min / Max Lon`
     obliczają się szybko (w ułamku sekundy) i wyświetlają konkretne liczby zamiast `--`.
3. **4 skrajne punkty geograficzne (Północ N, Południe S, Wschód E, Zachód W)**:
   * Sprawdź, czy pod statystykami widoczne są 4 wiersze punktów skrajnych: **Północ (N)**, **Południe (S)**, **Wschód (E)**, **Zachód (W)** wraz ze współrzędnymi.
   * Kliknij kolejno w każdy z tych 4 punktów (lub przycisk przelotu obok nich) i sprawdź:
     * czy kamera przelatuje do odpowiedniego skrajnego punktu na mapie,
     * czy na mapie widoczne są **4 wyróżnione znaczniki (N, S, E, W)** dokładnie w miejscach, gdzie ślad GPS sięga najdalej na północ, południe, wschód i zachód.

---

### KROK 3: Tryby wyświetlania śladu GPS i czystość "Zaznaczonych ścieżek OSM"
1. **Wybór dat i godzin**:
   * W drzewie **FILTR DAT** zaznacz wszystkie lata/miesiące lub wybrany dzień z bogatym śladem GPS.
   * W drzewie **FILTR GODZIN** przetestuj zawężenie widoku do wybranej godziny oraz 10-minutowego wycinka.
2. **Przełączanie 3 trybów śladu GPS**:
   * Przełącz tryb na **Surowe punkty GPS** — przybliż mapę i kliknij w pojedynczy punkt, aby sprawdzić dymek z danymi telemetrycznymi (prędkość, wysokość, czas, satelity, przeciążenia G).
   * Przełącz tryb na **Dociągnięte do ulicy** — sprawdź, czy punkty leżą równo na osiach dróg.
   * Przełącz tryb na **Zaznaczone ścieżki OSM** — przybliż mocno mapę (zoom 15–18) w miejscach, gdzie wcześniej występowały postoje lub gęsta zabudowa (np. okolice ul. Wawelskiej / Nieborowskiej / parkingów).
   * Zweryfikuj, czy linie śladów OSM są czyste, gładkie i biegną wzdłuż ulic (brak chaotycznych "pajęczyn" i zygzaków przecinających budynki).

---

### KROK 4: Warstwy mapy, Presety kolorów oraz Ikony Znaków Drogowych i POI
1. **Edytor warstw i Presety (`DOSTOSUJ WARSTWY MAPY`)**:
   * Rozwiń sekcję **DOSTOSUJ WARSTWY MAPY** w lewym panelu.
   * Upewnij się, że na dole **nie ma już** starego przycisku `"Przywróć domyślne kolory i warstwy"`.
   * Wybierz z listy presetów np. **Domyślny** (lub **Bezpieczeństwo i Fotoradary**), następnie zmień kolor lub wyłącz kilka warstw ręcznie, po czym **ponownie wybierz ten sam preset z listy**. Sprawdź, czy ponowne kliknięcie w ten sam preset natychmiast przywraca jego oryginalne kolory i widoczność warstw.
   * Zapisz własny preset przyciskiem zapisu i sprawdź, czy pojawia się na liście.
2. **Weryfikacja nowych ikon Infrastruktury Drogowej (przybliż mapę do zoom 14–17 w Gdańsku/Gdyni)**:
   * Włącz grupę **Infrastruktura drogowa** i sprawdź wygląd każdej z 5 warstw:
     1. **Sygnalizacja drogowa**: Czy wyświetla się czytelna ikona sygnalizatora świetlnego (czerwone/żółte/zielone światło w zaokrąglonej czarnej obudowie w stylu Apple Maps) i czy na jednym skrzyżowaniu jest **jedna wspólna ikona**, a nie 4–8 osobnych kropek na każdym wlocie?
     2. **Progi zwalniające**: Czy wyświetla się polski żółto-czerwony trójkątny znak ostrzegawczy **A-11a** (próg zwalniający)?
     3. **Przejścia dla pieszych**: Czy wyświetla się polski niebiesko-biały kwadratowy znak informacyjny **D-6** (pieszy na pasach)?
     4. **Fotoradary**: Czy wyświetla się polski niebieski znak informacyjny **D-51** (aparat fotograficzny)?
     5. **Odcinkowe pomiary prędkości**: Czy na początku i na końcu odcinka pomiarowego wyświetla się znak **D-51a** (aparat z dwoma ograniczeniami i odległością), a pomiędzy nimi linia odcinka pomiarowego?
3. **Punkty POI i szczegóły po kliknięciu**:
   * Włącz grupę **Punkty POI** (Miejsca kultu, Gastronomia, Opieka zdrowotna, Sklepy i usługi).
   * Kliknij w kilka różnych ikon POI oraz znaków infrastruktury na mapie — sprawdź, czy otwiera się czytelne okienko (popup) z polską kategorią, nazwą, adresem i godzinami otwarcia.

---

### KROK 5: Planer Trasy, Suwaki Unikania (w tym MAX = Minimum totalne), Unikanie Autostrad i Generator Tras
1. **Klasyczne wyznaczanie trasy z punktami unikania**:
   * Otwórz panel **Planuj trasę**.
   * Kliknij na mapie punkt startowy (A) oraz punkt docelowy (B) w obrębie Trójmiasta/Pomorza — sprawdź, czy trasa rysuje się po drogach wraz z czasem przejazdu, dystansem oraz statystykami przeszkód (liczba progów, świateł, przejść, rond i % nowych dróg).
   * Kliknij przycisk **Dodaj punkt unikania na mapie**, postaw czerwoną strefę zakazu bezpośrednio na wyznaczonej trasie i dostosuj jej promień (np. 300 m). Sprawdź, czy trasa w 100% omija czerwony okrąg.
2. **Unikanie autostrad i tryb suwaków `MAX (Minimum totalne)`**:
   * Zaznacz opcję **Unikaj autostrad i dróg ekspresowych** — sprawdź, czy trasa rezygnuje z Obwodnicy Trójmiasta (S6/S7) i dróg szybkiego ruchu na rzecz dróg lokalnych/wojewódzkich.
   * Przesuń suwak **Progi zwalniające** maksymalnie w prawo na wartość **MAX (`Minimum totalne`)** — sprawdź, czy opis zmienia się na `MAX (Minimum totalne)` i czy wyznaczona trasa redukuje liczbę progów zwalniających do absolutnego minimum (0 progów, o ile sam punkt startu/mety nie leży bezpośrednio na ulicy zamkniętej progami z każdej strony).
   * Przetestuj pozostałe suwaki (Przejścia dla pieszych, Sygnalizacja świetlna, Ronda, Skrzyżowania) w pozycjach pośrednich (`1–10`) oraz w pozycji `MAX`.
3. **Inteligentny Generator Trasy Automatycznej i 10 znaczników**:
   * Zostaw na mapie 1 punkt startowy (lub start i metę), wpisz docelowy dystans np. `25 km`, zaznacz `Powrót do punktu startowego (pętla)` oraz `Preferuj nieodwiedzone drogi` i kliknij **Generuj trasę automatycznie**.
   * Sprawdź:
     * czy wygenerowana trasa tworzy sensowną, ciągłą pętlę po drogach (bez dziwnych zawrotek o 180 stopni w losowych miejscach i bez punktów w wodzie/Zatoce),
     * czy na trasie zostało rozmieszczonych **maksymalnie 10 znaczników** w kluczowych punktach zwrotnych trasy,
     * jak działa przycisk **Otwórz w Google Maps** / **Kopiuj link Google Maps**,
     * jak działa nowy przycisk **Pobierz GPX (1:1)** — kliknij go i sprawdź, czy pobiera się plik `.gpx` z pełną dokładną ścieżką 1:1.

---

### KROK 6: Heatmapa, Odkrywanie Mapy (Mgła Wojny), Rysowanie, Odtwarzacz (Playback) i Eksport
1. **Heatmapa**:
   * Włącz przełącznik **Heatmapa** w lewym panelu — sprawdź, czy często odwiedzane ulice świecą na żółto/czerwono, a rzadko odwiedzane na zielono.
2. **Odkrywanie mapy (Mgła wojny)**:
   * Włącz przełącznik **Odkrywanie mapy (Mgła wojny)** — sprawdź, czy nieodwiedzone kwartały i trójkąty terenu są przyciemnione mgłą, a odwiedzone działki są odsłonięte, oraz czy licznik pokazuje odkrytą powierzchnię w $\text{km}^2$.
3. **Rysowanie po mapie**:
   * Otwórz narzędzie **Rysowanie po mapie**, narysuj linię / kształt / dodaj notatkę w wybranym kolorze, zapisz i odśwież stronę (F5) — sprawdź, czy rysunek zachowuje się na koncie.
4. **Odtwarzacz trasy (Playback HUD) i Timelapse**:
   * Wybierz pojedynczy dzień w drzewie dat i kliknij **Odtwórz dzień** — sprawdź animację pojazdu na mapie, zegary HUD, wykres wysokości, diagram przeciążeń G-G oraz widok satelitów.
   * Kliknij przycisk **Timelapse** i sprawdź animację postępu odkrywania mapy w czasie.
5. **Eksport i Import danych**:
   * Otwórz modal **Eksport danych** i przetestuj pobieranie w formatach HTML, PNG, SVG, GIF oraz GPX/CSV.
   * Otwórz modal **Parser / Import danych** i sprawdź podgląd zadań oraz formularz wgrywania plików.

---
---

## SEKCJA B: SZCZEGÓŁOWA ANKIETA DLA TESTERA (DO WYPEŁNIENIA)

Prosimy o szczere i szczegółowe odpowiedzi przy każdym punkcie (można wpisywać odpowiedzi bezpośrednio pod pytaniami):

### 1. Pierwsze wrażenie, estetyka ogólna i czytelność interfejsu (UI/UX)
1.1. Jak oceniasz ogólny wygląd aplikacji w skali 1–10? Co od razu przyciąga wzrok pozytywnie, a co wygląda na niedopracowane lub przytłaczające?
* **Odpowiedź:** 

1.2. Czy szerokość lewego panelu bocznego oraz prawego panelu planowania trasy jest odpowiednia na Twoim ekranie? Czy panele nie zasłaniają zbyt dużej części mapy?
* **Odpowiedź:** 

1.3. Czy półokrągłe uchwyty zwijania/rozwijania paneli bocznych ("ten cosiek" przy lewym i prawym panelu) są dobrze widoczne, łatwe do trafienia kursorem i umieszczone na odpowiedniej wysokości?
* **Odpowiedź:** 

1.4. Czy rozmiar czcionek, odstępy między sekcjami oraz kontrast tekstów na ciemnym tle paneli są wygodne do czytania bez mrużenia oczu?
* **Odpowiedź:** 

---

### 2. Nazewnictwo, etykiety i zrozumiałość opisów
2.1. Czy wszystkie nazwy przycisków, zakładek, warstw i opcji po polsku brzmią naturalnie i są od razu zrozumiałe? Które sformułowania zmienił(a)byś na inne?
* **Odpowiedź:** 

2.2. Czy nazwy 3 trybów śladu GPS (`Surowe punkty GPS`, `Dociągnięte do ulicy`, `Zaznaczone ścieżki OSM`) jasno tłumaczą różnicę między nimi?
* **Odpowiedź:** 

2.3. Czy w planerze trasy określenie `MAX (Minimum totalne)` na końcu suwaków przeszkód jest czytelne i intuicyjne, czy lepiej nazwać je inaczej (np. `Unikaj całkowicie`, `Bezwzględne minimum`, `Zero przeszkód`)?
* **Odpowiedź:** 

2.4. Czy nazwy wbudowanych presetów warstw (`Domyślny`, `Bezpieczeństwo i Fotoradary`, `Minimalistyczny`, `Eksploracja Miasta`) są trafne? Jakie inne gotowe presety warto dodać?
* **Odpowiedź:** 

---

### 3. Ikony znaków drogowych i punktów POI na mapie
3.1. Jak oceniasz wygląd i rozmiar nowych ikon infrastruktury drogowej na różnych poziomach przybliżenia mapy (zoom 12–18):
* **Sygnalizacja drogowa** (ikona sygnalizatora w stylu Apple Maps):
* **Progi zwalniające** (znak A-11a):
* **Przejścia dla pieszych** (znak D-6):
* **Fotoradary** (znak D-51):
* **Odcinkowe pomiary prędkości** (znaki D-51a na początku i końcu odcinka):

3.2. Czy ikony znaków drogowych nie są za duże ani za małe przy oddalaniu i przybliżaniu mapy? Czy nie nachodzą na siebie zbyt agresywnie w centrum miasta?
* **Odpowiedź:** 

3.3. Czy po zdeduplikowaniu sygnalizacji świetlnej (1 ikona na skrzyżowanie zamiast kilku na każdym pasie) mapa w Trójmieście jest wystarczająco czytelna?
* **Odpowiedź:** 

3.4. Czy dymek (popup) otwierany po kliknięciu w znak drogowy lub punkt POI (sklep, restaurację, kościół, szpital) zawiera wszystkie potrzebne informacje i wygląda estetycznie?
* **Odpowiedź:** 

---

### 4. Wygląd śladów GPS i "Zaznaczonych ścieżek OSM"
4.1. Jak oceniasz wygląd trybu **Zaznaczone ścieżki OSM** po dużym przybliżeniu mapy? Czy grubość linii i jej wygładzenie na zakrętach oraz skrzyżowaniach wyglądają teraz dobrze?
* **Odpowiedź:** 

4.2. Czy zauważyłeś(-aś) jeszcze gdziekolwiek na mapie artefakty typu "pajęczyna" / ostre kolce wynikające z postoju GPS, a jeśli tak — w jakiej dokładnie lokalizacji lub w którym dniu?
* **Odpowiedź:** 

---

### 5. Statystyki konta i 4 skrajne punkty geograficzne (N / S / E / W)
5.1. Czy sekcja **STATYSTYKI KONTA** ładuje się wystarczająco szybko i czy prezentowane w niej dane są czytelne?
* **Odpowiedź:** 

5.2. Jak oceniasz wygląd 4 znaczników skrajnych punktów (**Północ N, Południe S, Wschód E, Zachód W**) na mapie oraz wygodę przelatywania do nich z panelu bocznego? Czy powinny być widoczne cały czas, czy np. tylko po rozwinięciu statystyk / przełącznikiem?
* **Odpowiedź:** 

5.3. Jakiej dodatkowej statystyki brakuje Ci najbardziej w karcie Statystyki Konta (np. łączny czas jazdy, średnia prędkość, najdłuższa trasa jednego dnia, liczba odwiedzonych miast/gmin)?
* **Odpowiedź:** 

---

### 6. Planer trasy, Generator tras automatycznych, 10 znaczników i eksport do nawigacji
6.1. Jak oceniasz działanie **Punktów unikania (stref zakazu)** oraz przełącznika **Unikaj autostrad i dróg ekspresowych**? Czy trasy omijają wskazane miejsca zgodnie z Twoimi oczekiwaniami?
* **Odpowiedź:** 

6.2. Jak oceniasz działanie suwaków przeszkód ustawionych na **MAX (`Minimum totalne`)**? Czy wyznaczone trasy faktycznie prowadzą drogami bez progów zwalniających / świateł?
* **Odpowiedź:** 

6.3. Jak oceniasz jakość tras tworzonych przez **Generator trasy automatycznej** (np. pętla na 15 km, 30 km, 50 km)? Czy wygenerowana trasa jest ciekawa do przejechania samochodem/rowerem?
* **Odpowiedź:** 

6.4. Czy rozmieszczenie do **10 znaczników** na wygenerowanej trasie oraz eksport do **Google Maps** i **Pobierz GPX (1:1)** działają wygodnie? Z jakiej aplikacji nawigacyjnej na telefonie korzystasz najczęściej podczas jazdy (Google Maps, Yanosik, Waze, OsmAnd, Apple Maps, Garmin)?
* **Odpowiedź:** 

---

### 7. Heatmapa, Mgła Wojny, Odtwarzacz (Playback) i pozostałe funkcje
7.1. Jak oceniasz wygląd **Heatmapy** oraz **Odkrywania mapy (Mgły wojny)**? Czy kolory i przezroczystość tych warstw dobrze współgrają z ciemnym podkładem mapy?
* **Odpowiedź:** 

7.2. Czy **Odtwarzacz trasy (Playback HUD)** z wykresem wysokości, diagramem przeciążeń G-G i satelitami działa płynnie i czy wszystkie wskaźniki są zrozumiałe?
* **Odpowiedź:** 

7.3. Czy podczas przeklikiwania całej aplikacji natrafiłeś(-aś) na jakikolwiek błąd, niedziałający przycisk, przycięcie animacji lub niejasny komunikat? Opisz dokładnie krok po kroku, jak go wywołać:
* **Odpowiedź:** 

7.4. Jakie 3 najważniejsze zmiany lub nowości wprowadził(a)byś w kolejnej wersji platformy NNAPER?
* **Odpowiedź:** 

