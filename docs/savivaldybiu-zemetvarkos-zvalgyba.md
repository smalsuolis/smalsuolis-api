# Žemės paskirties keitimo skelbimai savivaldybėse — žvalgyba

Ar verta rašyti nuskaitymo skriptus likusioms 59 savivaldybėms, kaip padaryta su
Vilniumi (`integrations.savivaldybeZemetvarka.vilnius`).

Patikrintos **visos 60**. Kiekvienoje atidarytas bent vienas tikras skelbimas —
sąrašo puslapis nelaikytas įrodymu.

## Rezultatas

Po dviejų tikrinimo raundų — 10 agentų visoms 60, tada dar 4 neišspręstoms —
padengiamos **59 iš 60**.

|                                                                          | Savivaldybių |
| ------------------------------------------------------------------------ | ------------ |
| **Padengiama** (yra skelbimai su kadastro numeriu arba konvertuojamu ID) | **59**       |
| Prašymų tiesiog nėra (Visaginas, ~1/metus)                               | 1            |

Nė vienos savivaldybės, kurios duomenų nepavyktų pasiekti, neliko.

## Svarbiausia: yra centralizuotas šaltinis

`planuojustatau.lt` (TPS „Vartai") turi šio tipo skelbimus kiekvienai
savivaldybei. Nepriklausomas agentas patikrino visas 60 ir atsisiuntė **105**
`pagal_20_2_2*` poslapius:

|                                    | Savivaldybių |
| ---------------------------------- | ------------ |
| Turi puslapį su kadastro numeriais | **58 iš 60** |
| Turi 2026 m. duomenų               | **56**       |
| Neturi jokio turinio               | 1 (Rietavo)  |
| Turi turinį, bet be kadastro nr.   | 1 (Raseinių) |

Iš viso rasta 20 631 kadastro numerio atitikmuo.

### URL kelio konstruoti negalima

Kelias **nėra vienodas**. 10 savivaldybių apskritai neturi bazinio
`pagal_20_2_2`, o 17 turi po kelis poslapius (Kauno r. ir Vilniaus r. — po 7),
kur aktualūs duomenys yra **paskutiniame**, ne pirmame:

```
utenos_raj     /pagal_20_2_2_nuo_20221001     630 kad. nr.   2026-08-21
vilniaus_raj   /pagal_20_2_2_nuo_20250102    1410           2026-08-25
klaipedos_raj  /pagal_20_2_2_nuo_2024401     1217           2026-08-24   <- rašybos klaida
kauno_raj      /pagal_20_2_2_iki_nuo_2026     880           2026-08-26   <- nelogiškas
```

Slug'us privaloma imti iš kiekvienos savivaldybės skilties indekso.

### Datos — du formatai, ir tai jau kartą suklaidino

Dalis savivaldybių rašo ISO (`2026-08-21`), dalis — lietuviška ilgąja forma
(„2026 m. birželio 3 d."). Zarasai naudoja ilgąją; ieškant tik ISO atrodo, kad
paskutinis įrašas 2022-11-11, nors iš tikrųjų **2026-06-03**. Ta pati klaida
palietė Radviliškį (rodė 2025-04-24, iš tikrųjų 2026-06-09) ir Alytaus r.

Biržuose dar blogiau: datų HTML tekste beveik nėra — jos slypi **PDF nuorodų
keliuose** (`uploads/2026/07/`) ir failų viduje. Datų ištraukimas turi apimti ir
nuorodų kelius.

Ir rikiavimo tvarka nevienoda — Neringoje naujausi viršuje, Zarasuose ir
Alytaus r. apačioje. „Pirmas įrašas" netinka.

## Trys atvejai, kur portalo neužtenka

| Savivaldybė    | Kas negerai                                                                                                                           | Sprendimas                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Rietavo**    | Portalo puslapis — tuščias kevalas (102 simboliai). Visos jų portalo skiltys tuščios; savivaldybė vis dar nurodo nebeveikiantį TPDRIS | `rietavas.lt` WP REST API, `categories=8`. Srautas ~4–5/metus                                                         |
| **Alytaus r.** | Portalas nustojo pildomas **2025-08-07**                                                                                              | `arsa.lt/…/zemes-naudojimo-paskirties-keitimo-skelbimai/1198` — 54 skelbimai per 2026 m., perdavimo taškas 2025-08-11 |
| **Raseinių**   | Rašo tik „unikalus Nr.", 0 kadastro numerių                                                                                           | Konvertuoti per API (žr. žemiau)                                                                                      |

**Visagino** portale naujausias 2025-04-22, bet tai ne duomenų spraga — prašymų
tiesiog nėra. Per 2021-12…2025-04 iš viso 5 atvejai (~1/metus), ~18 tūkst.
gyventojų, beveik vien užstatytas miestas. Svetainės `sitemap.xml` rodo to
puslapio `lastmod = 2025-04-23`, nors naujienos atnaujinamos kasdien.

## Unikalus Nr. → kadastro Nr. konvertavimas

Projekto jau naudojamas `boundaries.biip.lt` turi tinkamą endpoint'ą, be
autentikacijos, iki 100 numerių per užklausą:

```bash
curl -X POST "https://boundaries.biip.lt/v1/parcels/search?srid=4326" \
  -H "Content-Type: application/json" \
  -d '{"filters":[{"parcels":{"unique_numbers":[724000010086]}}]}'
```

Grąžina `cadastral_number`, plotą **ir paruoštą geometriją** — tad kadastro nr.
reikalingas tik kaip žmogui rodomas identifikatorius.

Padengimas Raseiniuose: 2026 m. **31 iš 31 (100 %)**, 2025 m. 97 %.

**Mechaninio pertvarkymo daryti negalima.** `7213-0002-0086` → `7213/0002:0086`
duoda neegzistuojantį sklypą (`total: 0`); API grąžina `7213/0005:0086`. Ir visi
`4400-*` numeriai (52 % visų) aritmetiškai nekonvertuojami:
`4400-0031-3262` → `7213/0006:0194`.

Skelbimams be jokio numerio veikia grandinė
`streets/search` → `addresses/search` → `parcels/search` su `intersects`.
Kai yra tik kaimas be gatvės — gyvenvietės poligonas ir `precision: residential_area`.

## Trys integracijos modeliai

Ne 59 skirtingi skriptai, o trys šablonai:

| Modelis                          | Savivaldybių | Ką reiškia                                                         |
| -------------------------------- | ------------ | ------------------------------------------------------------------ |
| Atskiri URL kiekvienam skelbimui | 26           | kaip Vilnius: sąrašas → straipsnis                                 |
| Kaupiamasis puslapis             | 20           | **nėra atskirų URL** — reikia turinio diff'o pagal kad. nr. + datą |
| HTML lentelė                     | 5            | eilutė = skelbimas                                                 |
| Tik per portalą                  | 1            | savo svetainėje nėra                                               |

Kaupiamasis modelis yra vienintelis, kurio Vilniaus integracija **nemoka** — ji
seka naujus URL. Tai didžiausias techninis darbas.

## Visos 60

| Savivaldybė    | Svetainė                  | Kur                                      | Modelis     | Verdiktas        | Pastaba                                      |
| -------------- | ------------------------- | ---------------------------------------- | ----------- | ---------------- | -------------------------------------------- |
| Akmenės r.     | akmene.lt                 | `/skelbimai/33`                          | atskiri URL | **TINKA**        | seni įrašai tik su unikaliu Nr.              |
| Alytaus m.     | alytus.lt                 | `/lt/skelbimai?category=miesto-pletra…`  | atskiri URL | **TINKA**        | ~157 psl.; kitos etiketės nei Vilniaus       |
| Alytaus r.     | arsa.lt                   | `/…/paskirties-keitimo-skelbimai/1198`   | atskiri URL | **TINKA**        | 54 skelbimai per 2026; portalas pasenęs      |
| Anykščių r.    | anyksciai.lt              | `portalas`                               | kaupiamasis | **TINKA**        | meniu punktas veda į portalą                 |
| Birštono       | birstonas.lt              | `/prasymu-pakeisti…/`                    | lentelė     | **TINKA**        | dalis kad. nr. be skirtukų                   |
| Biržų r.       | birzai.lt                 | `/informacija-apie…/540`                 | lentelė     | **TINKA**        | prašymai tik PDF; sprendimai HTML lentelėje  |
| Druskininkų    | druskininkusavivaldybe.lt | `/veiklos-sritys/architektura…`          | kaupiamasis | **TINKA**        | NE druskininkai.lt (turizmo centras)         |
| Elektrėnų      | elektrenai.lt             | `/go.php/Prasymai962959`                 | kaupiamasis | **TINKA**        | 435 kad. nr.; portale 404                    |
| Ignalinos r.   | ignalina.lt               | `/skelbimai/397`                         | atskiri URL | **TINKA**        | mišri kategorija, filtruoti pagal antraštę   |
| Jonavos r.     | jonava.lt                 | `/veiklos-sritys/…/1924`                 | atskiri URL | **TINKA**        | geriausia struktūra iš visų                  |
| Joniškio r.    | joniskis.lt               | portalas                                 | portalas    | **TINKA**        | 148 kad. nr., 2026-04-03                     |
| Jurbarko r.    | jurbarkas.lt              | portalas                                 | portalas    | **TINKA**        | 311 kad. nr., 2026-08-18                     |
| Kaišiadorių r. | kaisiadorys.lt            | `/informacija-apie-priimtus…/2025`       | kaupiamasis | **TINKA**        | tik sprendimai po fakto                      |
| Kalvarijos     | kalvarija.lt              | `/prasymai-pakeisti…/`                   | lentelė     | **TINKA**        | 80 kad. nr.                                  |
| Kauno m.       | kaunas.lt                 | `/urbanistika/prasymai-pakeisti…/`       | atskiri URL | **TINKA**        | kad. nr. tik ~40 % skelbimų                  |
| Kauno r.       | krs.lt                    | `/savivaldybe/…/viesinimas/`             | kaupiamasis | **TINKA**        | NE kaunorajonas.lt; 936 kad. nr.             |
| Kazlų Rūdos    | kazluruda.lt              | `/prasymai-pakeisti…/315`                | lentelė     | **TINKA**        | rašo „KAD.NR.“ didžiosiomis                  |
| Kelmės r.      | kelme.lt                  | `/?s=informacija+apie+žemės+sklypo`      | atskiri URL | **TINKA**        | artimiausia Vilniaus modeliui                |
| Klaipėdos m.   | klaipeda.lt               | portalas                                 | portalas    | **TINKA**        | portale 67 kad. nr. HTML’e – OCR nereikia    |
| Klaipėdos r.   | klaipedos-r.lt            | `/skyriu-informacija/…/`                 | kaupiamasis | **TINKA**        | NE klaipedosrajonas.lt; tik sprendimai       |
| Kretingos r.   | kretinga.lt               | `/skelbimai/pagrindines-zemes…`          | atskiri URL | **TINKA**        | puslapiuota po 12                            |
| Kupiškio r.    | kupiskis.lt               | `/prasymai-pakeisti…/456`                | kaupiamasis | **TINKA**        | rašo „kad. Nr.“                              |
| Kėdainių r.    | kedainiai.lt              | `/veiklos-sritys/…/1817`                 | kaupiamasis | **TINKA**        | 210 kad. nr.; išankstiniai prašymai          |
| Lazdijų r.     | lazdijai.lt               | `/lt/architektura…/633`                  | atskiri URL | **TINKA**        | švariausias variantas                        |
| Marijampolės   | marijampole.lt            | `/prasymai-pakeisti…/1694`               | atskiri URL | **TINKA**        | įvardyti laukai; ?s= neindeksuoja            |
| Mažeikių r.    | mazeikiai.lt              | `/savivalda/…/prasymai-pakeisti…`        | kaupiamasis | **TINKA**        | tik einamųjų metų įrašai                     |
| Molėtų r.      | moletai.lt                | portalas                                 | portalas    | **TINKA**        | 485 kad. nr., 2026-08-07                     |
| Neringos       | neringa.lt                | `/lt/prasymai-pakeisti…/742`             | atskiri URL | **TINKA**        | ~13 skelbimų; „Planuojama nauja“             |
| Pagėgių        | pagegiai.lt               | `/architektura…/prasymai…/`              | kaupiamasis | **TINKA**        | Elementor akordeonas, 99 kad. nr.            |
| Pakruojo r.    | pakruojis.lt              | `/gyventojams/skelbimai/138`             | atskiri URL | **TINKA**        | mišrus sąrašas, reikia filtro                |
| Palangos m.    | palanga.lt                | `/savivaldybe/…/5958`                    | atskiri URL | **TINKA**        | WAF – reikia naršyklės User-Agent            |
| Panevėžio m.   | panevezys.lt              | `/lt/veiklos-sritys/…mex2.html`          | atskiri URL | **TINKA**        | kad. nr. matomas jau sąraše                  |
| Panevėžio r.   | panrs.lt                  | `/category/budo-keitimas/`               | atskiri URL | **TINKA**        | kad. nr. antraštėje; yra RSS                 |
| Pasvalio r.    | pasvalys.lt               | `/veiklos-sritys/…/3704`                 | kaupiamasis | **TINKA**        | ?s= neveikia (POST)                          |
| Plungės r.     | plunge.lt                 | `/veiklos-sritys/…/`                     | lentelė     | **TINKA**        | lentelės pagal metus                         |
| Prienų r.      | prienai.lt                | `/gyventojams/…/`                        | kaupiamasis | **TINKA**        | 120 kad. nr.; nenaudoti /document/           |
| Radviliškio r. | radviliskis.lt            | `/zemes-sklypo-naudojimo…/`              | kaupiamasis | **TINKA**        | 64 kad. nr. nuo 2023                         |
| Raseinių r.    | raseiniai.lt              | `/2026-m/`                               | kaupiamasis | **TINKA**        | unikalus Nr. → kadastro per boundaries API   |
| Rietavo        | rietavas.lt               | `/wp-json/wp/v2/posts?categories=8`      | atskiri URL | **TINKA**        | portalas tuščias; ~4–5 per metus             |
| Rokiškio r.    | rokiskis.lt               | `portalas`                               | portalas    | **TINKA**        | savo svetainėje nėra; portale 76 kad. nr.    |
| Skuodo r.      | skuodas.lt                | `/category/pranesimai/`                  | atskiri URL | **TINKA**        | plati kategorija, reikia filtro              |
| Tauragės r.    | taurage.lt                | `/veiklos-sritys/urbanistika…/`          | kaupiamasis | **TINKA**        | 301 kad. nr.; nėra datų laukų                |
| Telšių r.      | telsiai.lt                | `/naujienos?category=712`                | atskiri URL | **TINKA**        | architektūra kaip Vilniaus                   |
| Trakų r.       | trakai.lt                 | `/architektura…/5536`                    | kaupiamasis | **TINKA**        | archyvas skaidomas į -5, -6…                 |
| Ukmergės r.    | ukmerge.lt                | `/nuo-2021-07-01…-2026-m/`               | kaupiamasis | **TINKA**        | 2021–2024 dalis dingusi                      |
| Utenos r.      | utena.lt                  | portalas                                 | portalas    | **TINKA**        | `pagal_20_2_2_nuo_20221001`, 917 kad. nr.    |
| Varėnos r.     | varena.lt                 | `/veiklos-sritys/teritoriju-planavimas/` | kaupiamasis | **TINKA**        | 254 kad. nr. statiniame puslapyje            |
| Vilkaviškio r. | vilkaviskis.lt            | `/teritorijos/`                          | atskiri URL | **TINKA**        | WAF; be wp-json                              |
| Vilniaus m.    | vilnius.lt                | `/naujienos/?categories=65`              | atskiri URL | **TINKA**        | etalonas, jau integruota                     |
| Vilniaus r.    | vrsa.lt                   | `/numatomas-pagrindines…/2014`           | kaupiamasis | **TINKA**        | 242 kad. nr. 2026 m. puslapyje               |
| Visagino       | visaginas.lt              | `/teritoriju-planavimas…/7657`           | kaupiamasis | **NĖRA PRAŠYMŲ** | ~1 per metus; naujausias 2025-04-22          |
| Zarasų r.      | zarasai.lt                | portalas                                 | portalas    | **TINKA**        | 273 kad. nr., 2026-06-03 (ilgoji datų forma) |
| Šakių r.       | sakiai.lt                 | `/puslapiai/teritoriju-planavimas…`      | kaupiamasis | **TINKA**        | ~700 KB puslapis, 164 kad. nr.               |
| Šalčininkų r.  | salcininkai.lt            | `/teritoriju-planavimas/…/2280`          | atskiri URL | **TINKA**        | kad. nr. jau sąraše                          |
| Šiaulių m.     | siauliai.lt               | `/ads`                                   | atskiri URL | **TINKA**        | TIKSLIAI Vilniaus etiketės                   |
| Šiaulių r.     | siauliuraj.lt             | `/zemes-sklypo-naudojimo…/2898`          | atskiri URL | **TINKA**        | reikia metų/mėn. filtro                      |
| Šilalės r.     | silale.lt                 | `WP archyvas pagal datą`                 | atskiri URL | **TINKA**        | slug be kad. nr.                             |
| Šilutės r.     | silute.lt                 | `/prasymai-pakeisti…/8217`               | atskiri URL | **TINKA**        | ~390 įrašų archyvas                          |
| Širvintų r.    | sirvintos.lt              | portalas                                 | portalas    | **TINKA**        | 218 kad. nr., 2026-08-26                     |
| Švenčionių r.  | svencionys.lt             | `/veiklos-sritys/…/`                     | atskiri URL | **TINKA**        | kad. nr. slug'e; portalas atsilikęs          |

## Ką rado agentai, ko neranda skriptas

Žvalgybą pirma bandžiau automatiniu skriptu
(`scripts/survey-municipality-landuse.ts`). Jis rado 6 savivaldybes; agentai — 52. Skirtumo priežastys verta žinoti, nes jos kartosis:

1. **Vidinė paieška meluoja.** Marijampolėje, Alytuje, Varėnoje ir Šakiuose
   `?s=` tų sekcijų neindeksuoja — skelbimai pasiekiami tik per meniu.
2. **Trys „žinomi" domenai buvo turizmo centrų svetainės**, ne savivaldybių:
   `druskininkai.lt`, `kaunorajonas.lt`, `klaipedosrajonas.lt`. Tikrieji —
   `druskininkusavivaldybe.lt`, `krs.lt`, `klaipedos-r.lt`. Patikra pagal
   pavadinimą to nepagavo, nes turizmo svetainėse pavadinimas irgi yra.
3. **Skelbimo tekstas yra straipsnio viduje**, ne sąraše.
4. **Formuluotės skiriasi.** Vilniaus etiketės („Esama pagrindinė žemės
   naudojimo paskirtis") pažodžiui sutampa tik Šiaulių m. Visur kitur — laisvas
   tekstas su „Vadovaudamiesi LR TPĮ 20 str. 2 d. 2 p.".

Patikimiausias bendras raktas — kadastro numerio regex, bet jis turi dengti:
`5247/0011:199`, `8730/0002:0248` (su nuliais), `69080002156` (be skirtukų),
`5136-0003-0119` (su brūkšneliais), ir rašybas `kadastro Nr.`, `kadastrinis Nr.`,
`kad. Nr.`, `KAD.NR.`.

## Kliūtys

| Savivaldybė                 | Kliūtis                                      |
| --------------------------- | -------------------------------------------- | ---------- | ----------- | --------- | ------------------------------------------ |
| Klaipėdos m.                | 2026 m. PDF – skenuoti vaizdai, be OCR ~39 % | portalas   | portalas    | **TINKA** | portale 67 kad. nr. HTML’e – OCR nereikia  |
| Palangos m., Vilkaviškio r. | WAF – reikia naršyklės User-Agent            |
| Joniškio r.                 | WAF blokuoja POST (GET veikia)               | portalas   | portalas    | **TINKA** | 148 kad. nr., 2026-04-03                   |
| Raseinių r.                 | identifikatorius – unikalus Nr., ne kadastro | `/2026-m/` | kaupiamasis | **TINKA** | unikalus Nr. → kadastro per boundaries API |
| Ukmergės r.                 | 2021–2024 m. dokumentų dalis dingusi         |

Nė viena kita svetainė neblokavo paprasto `curl` — Vilniaus proxy poreikis
pasirodė esąs išimtis, ne taisyklė.

## Etapo skirtumas

Dalis savivaldybių skelbia **išankstinius prašymus** su 10 darbo dienų terminu
pastaboms (Vilnius, Kauno r., Kėdainių r., Kalvarijos, Kelmės, Šiaulių m.,
Neringos). Kitos — tik **priimtus sprendimus po fakto** (Kaišiadorių r.,
Klaipėdos r., Visagino, Biržų r. dalis).

Smalsuoliui vertingas pirmasis tipas: pranešti, kol dar galima reaguoti. Į tai
verta atsižvelgti renkantis eiliškumą.

## Ką daryčiau

1. **Vienas servisas prieš `planuojustatau.lt`** — padengia 56 savivaldybes.
   Slug'us ir poslapius imti iš indekso, ne konstruoti; datas parsinti abiem
   formatais ir iš PDF nuorodų kelių.
2. **Trys išimtys atskirai** — Rietavas (WP REST), Alytaus r. (`arsa.lt/1198`),
   Raseiniai (unikalus Nr. → API).
3. **Visaginą stebėti**, bet neskubėti — prašymų ten atsiranda apie vieną per
   metus.

Savivaldybių svetainės lieka kaip atsarginis šaltinis ten, kur portalas
atsilieka. Pilna 60 lentelė žemiau rodo, kur ką rasti.

## Trys gedimo režimai, kuriuos verta stebėti

Tikrinant paaiškėjo, kad „portale nieko naujo" reiškia tris skirtingus dalykus,
ir supainioti juos brangu:

1. **Tikra tyla** — prašymų nėra (Visaginas). Nieko daryti nereikia.
2. **Portalas nustojo pildomas** — duomenys persikėlė kitur (Alytaus r., nuo
   2025-08). Reikia atsarginio šaltinio.
3. **Duomenys yra, bet nematomi** — datos ilgąja forma (Zarasai, Radviliškis)
   arba tik PDF nuorodų keliuose (Biržai). Reikia geresnio parserio.

Monitoringas turėtų juos skirti, kitaip trečiasis atrodys kaip pirmasis.

Teisinis kontekstas: nuo 2026-07-01, pasikeitus LRV nutarimui Nr. 1073, prašymai
priimami tik elektroniškai per TPS „Vartai". Centralizuotas šaltinis turėtų
pilnėti, o savivaldybių puslapiai — tuštėti.
