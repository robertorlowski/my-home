# Aplikacja Androida (TWA)

Opakowanie aplikacji webowej w aplikację Androida metodą Trusted Web Activity (2026-10-21): aplikacja otwiera
`https://dom.mojeturnie.pl` w Chrome bez paska adresu, z ikoną i powiadomieniami Web Push. Projekt generuje
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) z pliku `twa-manifest.json`; kodu Androida nie pisze się
ręcznie. Aktualizacje aplikacji to nadal wdrożenie klienta na serwer — pakiet w sklepie zmienia się tylko przy zmianie
ikony, nazwy, domeny albo wersji Androida.

## Pliki

| Plik | Rola |
|---|---|
| `twa-manifest.json` | opis aplikacji dla Bubblewrap: pakiet `pl.infotower.myhome`, domena, kolory, ikony z produkcji, `startUrl: /devices`, odcisk klucza |
| `app/`, `build.gradle`, `gradle/`, `gradlew*` | projekt Androida wygenerowany przez `bubblewrap update` (commitowany, żeby build był powtarzalny) |
| `android.keystore`, `keystore.local.json` | **poza gitem**: klucz podpisu (alias `android`) i hasła. Zgubienie klucza = nowa aplikacja w sklepie. Kopia zapasowa poza repozytorium |
| `../client/public/.well-known/assetlinks.json` | Digital Asset Links: nazwa pakietu i odciski SHA-256 kluczy podpisu; bez niego Chrome pokazuje pasek adresu |

## Środowisko (raz na komputer)

- JDK 17 (`C:\Program Files\Eclipse Adoptium\jdk-17.0.7.7-hotspot`) i Android SDK w `C:\Users\<użytkownik>\android-sdk`
  (`cmdline-tools/latest`, `platform-tools`, `build-tools 34.0.0 i 36.1.0`, `platforms/android-34`; Bubblewrap szuka
  `sdkmanager` w `<sdk>/bin`, więc `bin` i `lib` to złączenia do `cmdline-tools/latest/*`).
- `npm i -g @bubblewrap/cli`; ścieżki w `~/.bubblewrap/config.json` (`jdkPath`, `androidSdkPath`); `bubblewrap doctor`.

## Budowanie

```powershell
cd android
bubblewrap update --directory . --manifest ./twa-manifest.json   # tylko po zmianie twa-manifest.json (pyta o nową wersję)
powershell -ExecutionPolicy Bypass -File build.ps1               # gradle + zipalign + apksigner + jarsigner
```

`build.ps1` robi to, co `bubblewrap build` (który z Git Bash nie znajduje `gradlew.bat`): `gradlew assembleRelease
bundleRelease`, potem podpis — wynik `app-release-signed.apk` (telefon) i `app-release-bundle.aab` (Play); `-SkipGradle`
podpisuje bez ponownej kompilacji. Minimalny Android to 7.0 (API 24, wymóg biblioteki `androidbrowserhelper`; Bubblewrap
wpisuje 21 i build się wywraca — `minSdkVersion` jest poprawione w `twa-manifest.json` i `app/build.gradle`).

`bubblewrap update` pobiera ikony z `iconUrl` / `maskableIconUrl`, więc produkcja musi mieć już PNG z etapu PWA
(przed wdrożeniem można wskazać `http://localhost:4173/...` z `vite preview` i po wygenerowaniu wrócić do produkcji).

## Instalacja na telefonie bez sklepu

`app-release-signed.apk` przez USB (`adb install`) albo plik na telefonie („zezwól na instalację z tego źródła”).
Pasek adresu znika, gdy `https://dom.mojeturnie.pl/.well-known/assetlinks.json` odpowiada z `Content-Type:
application/json` i zawiera odcisk klucza, którym podpisano pakiet.

## Google Play (etap 2b)

1. Konto dewelopera, aplikacja `pl.infotower.myhome`, wysyłka `app-release-bundle.aab` do testu wewnętrznego.
2. Play podpisuje aplikację własnym kluczem: odcisk z Play Console → Konfiguracja → Integralność aplikacji dopisać do
   `assetlinks.json` (obok odcisku klucza do wysyłki) i do `fingerprints` w `twa-manifest.json`, potem wdrożyć klienta.
3. Polityka prywatności pod publicznym adresem, formularz „Bezpieczeństwo danych”, grafika (ikona 512, baner 1024×500,
   zrzuty), usuwanie konta (jest w aplikacji: „Moje dane” → „Usuń konto…”).
4. Konto osobiste przed produkcją: test zamknięty 12 testerów przez 14 dni; do użytku domowego wystarczy test wewnętrzny.
