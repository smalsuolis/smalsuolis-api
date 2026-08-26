# Žemės paskirties keitimo skelbimai savivaldybėse — žvalgyba

Ar verta rašyti nuskaitymo skriptus likusioms 59 savivaldybėms, kaip padaryta su
Vilniumi (`integrations.savivaldybeZemetvarka.vilnius`).

Patikrintos **visos 60**. Kiekvienoje atidarytas bent vienas tikras skelbimas —
sąrašo puslapis nelaikytas įrodymu.

## Rezultatas

|                                                      | Savivaldybių |
| ---------------------------------------------------- | ------------ |
| **TINKA** — atidarytas skelbimas su kadastro numeriu | **52**       |
| NEAIŠKU — skelbia, bet kadastro nr. nepasiekiamas    | 3            |
| NESKELBIA savo svetainėje                            | 5            |
| **Iš viso**                                          | 60           |

## Svarbiausia: yra centralizuotas šaltinis

`planuojustatau.lt` (TPS „Vartai") turi atskirą puslapį kiekvienai savivaldybei
pagal TPĮ 20 str. 2 d. 2 p.:

```
https://www.planuojustatau.lt/lt/planuoju_rtpd/<slug>/pagal_20_2_2
```

Slug'ų sąrašas: `/lt/planuoju_rtpd/savivaldybes_vietoves_lygmens_tpd`.
Patikrinti visi 61: **48 grąžina puslapį su kadastro numeriais**, 2 tušti,
10 — 404 (būtent tos, kurios skelbia savo svetainėse).

**Bet pasikliauti vien juo negalima.** Šviežumas skiriasi:

| Savivaldybė   | Portale naujausia | Savo svetainėje |
| ------------- | ----------------- | --------------- |
| Molėtų r.     | 2026-08-07        | neskelbia       |
| Joniškio r.   | 2026-04-03        | neskelbia       |
| Švenčionių r. | **2023-12-13**    | **2025-11-19**  |
| Zarasų r.     | **2022-11-11**    | neskelbia       |

Švenčionyse portalas atsilikęs beveik dvejais metais, nors savivaldybė skelbia
toliau. Prieš pasikliaujant reikia patikrinti šviežumą kiekvienai atskirai.

Portalas neturi API — `/api`, `/jsonapi`, `/opendata`, `/sitemap.xml` visi 404.
`robots.txt` draudžia `/search/`, bet `planuoju_rtpd` puslapių — ne.

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

| Savivaldybė    | Svetainė                  | Kur                                       | Modelis     | Verdiktas     | Pastaba                                         |
| -------------- | ------------------------- | ----------------------------------------- | ----------- | ------------- | ----------------------------------------------- |
| Akmenės r.     | akmene.lt                 | `/skelbimai/33`                           | atskiri URL | **TINKA**     | seni įrašai tik su unikaliu Nr.                 |
| Alytaus m.     | alytus.lt                 | `/lt/skelbimai?category=miesto-pletra…`   | atskiri URL | **TINKA**     | ~157 psl.; kitos etiketės nei Vilniaus          |
| Alytaus r.     | arsa.lt                   | `/lt/skelbimai/teritoriju-planavimas/725` | atskiri URL | **TINKA**     | daugiausia detalieji planai; prašymai – portale |
| Anykščių r.    | anyksciai.lt              | `portalas`                                | kaupiamasis | **TINKA**     | meniu punktas veda į portalą                    |
| Birštono       | birstonas.lt              | `/prasymu-pakeisti…/`                     | lentelė     | **TINKA**     | dalis kad. nr. be skirtukų                      |
| Biržų r.       | birzai.lt                 | `/informacija-apie…/540`                  | lentelė     | **TINKA**     | prašymai tik PDF; sprendimai HTML lentelėje     |
| Druskininkų    | druskininkusavivaldybe.lt | `/veiklos-sritys/architektura…`           | kaupiamasis | **TINKA**     | NE druskininkai.lt (turizmo centras)            |
| Elektrėnų      | elektrenai.lt             | `/go.php/Prasymai962959`                  | kaupiamasis | **TINKA**     | 435 kad. nr.; portale 404                       |
| Ignalinos r.   | ignalina.lt               | `/skelbimai/397`                          | atskiri URL | **TINKA**     | mišri kategorija, filtruoti pagal antraštę      |
| Jonavos r.     | jonava.lt                 | `/veiklos-sritys/…/1924`                  | atskiri URL | **TINKA**     | geriausia struktūra iš visų                     |
| Joniškio r.    | joniskis.lt               | `—`                                       | portalas    | **NESKELBIA** | 627 įrašai peržiūrėti – 0                       |
| Jurbarko r.    | jurbarkas.lt              | `—`                                       | portalas    | **NESKELBIA** | tik planuojustatau.lt                           |
| Kaišiadorių r. | kaisiadorys.lt            | `/informacija-apie-priimtus…/2025`        | kaupiamasis | **TINKA**     | tik sprendimai po fakto                         |
| Kalvarijos     | kalvarija.lt              | `/prasymai-pakeisti…/`                    | lentelė     | **TINKA**     | 80 kad. nr.                                     |
| Kauno m.       | kaunas.lt                 | `/urbanistika/prasymai-pakeisti…/`        | atskiri URL | **TINKA**     | kad. nr. tik ~40 % skelbimų                     |
| Kauno r.       | krs.lt                    | `/savivaldybe/…/viesinimas/`              | kaupiamasis | **TINKA**     | NE kaunorajonas.lt; 936 kad. nr.                |
| Kazlų Rūdos    | kazluruda.lt              | `/prasymai-pakeisti…/315`                 | lentelė     | **TINKA**     | rašo „KAD.NR.“ didžiosiomis                     |
| Kelmės r.      | kelme.lt                  | `/?s=informacija+apie+žemės+sklypo`       | atskiri URL | **TINKA**     | artimiausia Vilniaus modeliui                   |
| Klaipėdos m.   | klaipeda.lt               | `/lt/…/8961`                              | lentelė     | **NEAIŠKU**   | 2026 m. PDF – skenai; be OCR ~39 %              |
| Klaipėdos r.   | klaipedos-r.lt            | `/skyriu-informacija/…/`                  | kaupiamasis | **TINKA**     | NE klaipedosrajonas.lt; tik sprendimai          |
| Kretingos r.   | kretinga.lt               | `/skelbimai/pagrindines-zemes…`           | atskiri URL | **TINKA**     | puslapiuota po 12                               |
| Kupiškio r.    | kupiskis.lt               | `/prasymai-pakeisti…/456`                 | kaupiamasis | **TINKA**     | rašo „kad. Nr.“                                 |
| Kėdainių r.    | kedainiai.lt              | `/veiklos-sritys/…/1817`                  | kaupiamasis | **TINKA**     | 210 kad. nr.; išankstiniai prašymai             |
| Lazdijų r.     | lazdijai.lt               | `/lt/architektura…/633`                   | atskiri URL | **TINKA**     | švariausias variantas                           |
| Marijampolės   | marijampole.lt            | `/prasymai-pakeisti…/1694`                | atskiri URL | **TINKA**     | įvardyti laukai; ?s= neindeksuoja               |
| Mažeikių r.    | mazeikiai.lt              | `/savivalda/…/prasymai-pakeisti…`         | kaupiamasis | **TINKA**     | tik einamųjų metų įrašai                        |
| Molėtų r.      | moletai.lt                | `—`                                       | portalas    | **NESKELBIA** | tik planuojustatau.lt (2026-08-07)              |
| Neringos       | neringa.lt                | `/lt/prasymai-pakeisti…/742`              | atskiri URL | **TINKA**     | ~13 skelbimų; „Planuojama nauja“                |
| Pagėgių        | pagegiai.lt               | `/architektura…/prasymai…/`               | kaupiamasis | **TINKA**     | Elementor akordeonas, 99 kad. nr.               |
| Pakruojo r.    | pakruojis.lt              | `/gyventojams/skelbimai/138`              | atskiri URL | **TINKA**     | mišrus sąrašas, reikia filtro                   |
| Palangos m.    | palanga.lt                | `/savivaldybe/…/5958`                     | atskiri URL | **TINKA**     | WAF – reikia naršyklės User-Agent               |
| Panevėžio m.   | panevezys.lt              | `/lt/veiklos-sritys/…mex2.html`           | atskiri URL | **TINKA**     | kad. nr. matomas jau sąraše                     |
| Panevėžio r.   | panrs.lt                  | `/category/budo-keitimas/`                | atskiri URL | **TINKA**     | kad. nr. antraštėje; yra RSS                    |
| Pasvalio r.    | pasvalys.lt               | `/veiklos-sritys/…/3704`                  | kaupiamasis | **TINKA**     | ?s= neveikia (POST)                             |
| Plungės r.     | plunge.lt                 | `/veiklos-sritys/…/`                      | lentelė     | **TINKA**     | lentelės pagal metus                            |
| Prienų r.      | prienai.lt                | `/gyventojams/…/`                         | kaupiamasis | **TINKA**     | 120 kad. nr.; nenaudoti /document/              |
| Radviliškio r. | radviliskis.lt            | `/zemes-sklypo-naudojimo…/`               | kaupiamasis | **TINKA**     | 64 kad. nr. nuo 2023                            |
| Raseinių r.    | raseiniai.lt              | `/teritoriju-planavimas-skelbimai/`       | kaupiamasis | **NEAIŠKU**   | identifikatorius – unikalus Nr., ne kadastro    |
| Rietavo        | rietavas.lt               | `/category/skelbimai/`                    | atskiri URL | **TINKA**     | 2 skelbimai per 2026; WP REST atviras           |
| Rokiškio r.    | rokiskis.lt               | `portalas`                                | portalas    | **TINKA**     | savo svetainėje nėra; portale 76 kad. nr.       |
| Skuodo r.      | skuodas.lt                | `/category/pranesimai/`                   | atskiri URL | **TINKA**     | plati kategorija, reikia filtro                 |
| Tauragės r.    | taurage.lt                | `/veiklos-sritys/urbanistika…/`           | kaupiamasis | **TINKA**     | 301 kad. nr.; nėra datų laukų                   |
| Telšių r.      | telsiai.lt                | `/naujienos?category=712`                 | atskiri URL | **TINKA**     | architektūra kaip Vilniaus                      |
| Trakų r.       | trakai.lt                 | `/architektura…/5536`                     | kaupiamasis | **TINKA**     | archyvas skaidomas į -5, -6…                    |
| Ukmergės r.    | ukmerge.lt                | `/nuo-2021-07-01…-2026-m/`                | kaupiamasis | **TINKA**     | 2021–2024 dalis dingusi                         |
| Utenos r.      | utena.lt                  | `—`                                       | portalas    | **NESKELBIA** | peržiūrėti 65 įrašai – 0 atitikmenų             |
| Varėnos r.     | varena.lt                 | `/veiklos-sritys/teritoriju-planavimas/`  | kaupiamasis | **TINKA**     | 254 kad. nr. statiniame puslapyje               |
| Vilkaviškio r. | vilkaviskis.lt            | `/teritorijos/`                           | atskiri URL | **TINKA**     | WAF; be wp-json                                 |
| Vilniaus m.    | vilnius.lt                | `/naujienos/?categories=65`               | atskiri URL | **TINKA**     | etalonas, jau integruota                        |
| Vilniaus r.    | vrsa.lt                   | `/numatomas-pagrindines…/2014`            | kaupiamasis | **TINKA**     | 242 kad. nr. 2026 m. puslapyje                  |
| Visagino       | visaginas.lt              | `/teritoriju-planavimas…/7657`            | kaupiamasis | **TINKA**     | mažas srautas, daugiausia po fakto              |
| Zarasų r.      | zarasai.lt                | `—`                                       | —           | **NESKELBIA** | portale paskutinis 2022-11-11                   |
| Šakių r.       | sakiai.lt                 | `/puslapiai/teritoriju-planavimas…`       | kaupiamasis | **TINKA**     | ~700 KB puslapis, 164 kad. nr.                  |
| Šalčininkų r.  | salcininkai.lt            | `/teritoriju-planavimas/…/2280`           | atskiri URL | **TINKA**     | kad. nr. jau sąraše                             |
| Šiaulių m.     | siauliai.lt               | `/ads`                                    | atskiri URL | **TINKA**     | TIKSLIAI Vilniaus etiketės                      |
| Šiaulių r.     | siauliuraj.lt             | `/zemes-sklypo-naudojimo…/2898`           | atskiri URL | **TINKA**     | reikia metų/mėn. filtro                         |
| Šilalės r.     | silale.lt                 | `WP archyvas pagal datą`                  | atskiri URL | **TINKA**     | slug be kad. nr.                                |
| Šilutės r.     | silute.lt                 | `/prasymai-pakeisti…/8217`                | atskiri URL | **TINKA**     | ~390 įrašų archyvas                             |
| Širvintų r.    | sirvintos.lt              | `portalas`                                | portalas    | **NEAIŠKU**   | savo puslapyje – tik detalieji planai           |
| Švenčionių r.  | svencionys.lt             | `/veiklos-sritys/…/`                      | atskiri URL | **TINKA**     | kad. nr. slug'e; portalas atsilikęs             |

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
| --------------------------- | -------------------------------------------- |
| Klaipėdos m.                | 2026 m. PDF – skenuoti vaizdai, be OCR ~39 % |
| Palangos m., Vilkaviškio r. | WAF – reikia naršyklės User-Agent            |
| Joniškio r.                 | WAF blokuoja POST (GET veikia)               |
| Raseinių r.                 | identifikatorius – unikalus Nr., ne kadastro |
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

1. **Vienas servisas prieš `planuojustatau.lt`** — 48 savivaldybės, viena
   struktūra. Prieš tai — šviežumo patikra kiekvienai.
2. **Šiaulių m.** — Vilniaus parseris tinka beveik be pakeitimų. Pigiausia antra
   integracija.
3. **Kaupiamųjų puslapių modelis** — bendras diff'o mechanizmas pagal kadastro
   nr. + datą. Atrakina 20 savivaldybes.
4. Likusios pavienės.

Teisinis kontekstas: nuo 2026-07-01, pasikeitus LRV nutarimui Nr. 1073, prašymai
priimami tik elektroniškai per TPS „Vartai". Centralizuotas šaltinis turėtų
pilnėti, o savivaldybių puslapiai — tuštėti.
