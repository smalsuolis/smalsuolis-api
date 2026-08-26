# Žemės paskirties keitimo skelbimai savivaldybėse — žvalgyba

Ar verta rašyti nuskaitymo skriptus likusioms 59 savivaldybėms, kaip padaryta su
Vilniumi (`integrations.savivaldybeZemetvarka.vilnius`). Šis dokumentas atsako,
kur tokie skelbimai apskritai yra.

Duomenys surinkti `scripts/survey-municipality-landuse.ts`; žalias JSON —
`scripts/out/municipality-landuse-survey.json`.

## Rezultatas

|                                          | Savivaldybių |
| ---------------------------------------- | ------------ |
| Rasta skelbimų **su kadastro numeriais** | 6            |
| Rasta tik terminų, be kadastro numerių   | 11           |
| Svetainė pasiekiama, nieko nerasta       | 25           |
| Svetainės adresas neaiškus               | 18           |
| **Iš viso**                              | 60           |

## Tinka nuskaitymui iš karto

Puslapyje randami ir skelbimai, ir kadastro numeriai — tai viskas, ko reikia
Vilniaus tipo integracijai.

| Savivaldybė      | Svetainė                 | Kur rasta                                                           |
| ---------------- | ------------------------ | ------------------------------------------------------------------- |
| Birštono sav.    | https://www.birstonas.lt | https://www.birstonas.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas |
| Vilniaus m. sav. | https://www.vilnius.lt   | https://www.vilnius.lt/naujienos/?categories=65                     |
| Kelmės r. sav.   | https://www.kelme.lt     | https://www.kelme.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas     |
| Pagėgių sav.     | https://www.pagegiai.lt  | https://www.pagegiai.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas  |
| Prienų r. sav.   | https://www.prienai.lt   | https://www.prienai.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas   |
| Šilalės r. sav.  | https://www.silale.lt    | https://www.silale.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas    |

Penkios iš šešių naudoja tą patį WordPress paieškos šabloną (`/?s=`), o Vilnius —
naujienų kategoriją.

## Reikia žmogaus žvilgsnio

Terminai randami, bet kadastro numerių tame puslapyje nėra. Gali būti, kad jie
yra straipsnio viduje, PDF'e arba skelbimai formuluojami kitaip.

| Savivaldybė       | Svetainė                        | Kur rasta                                                                         |
| ----------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| Druskininkų sav.  | https://www.druskininkai.lt     | https://www.druskininkai.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas            |
| Kauno m. sav.     | https://www.kaunas.lt           | https://www.kaunas.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas                  |
| Šiaulių m. sav.   | https://www.siauliai.lt         | https://www.siauliai.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas                |
| Varėnos r. sav.   | https://www.varena.lt           | https://www.varena.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas                  |
| Vilniaus r. sav.  | https://www.vrsa.lt             | https://www.vrsa.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas                    |
| Kalvarijos sav.   | https://www.kalvarija.lt        | https://www.kalvarija.lt/teritoriju-planavimas                                    |
| Kauno r. sav.     | https://www.kaunorajonas.lt     | https://www.kaunorajonas.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas            |
| Klaipėdos r. sav. | https://www.klaipedosrajonas.lt | https://www.klaipedosrajonas.lt/paieska?q=%C5%BEem%C4%97s%20paskirties%20keitimas |
| Kretingos r. sav. | https://www.kretinga.lt         | https://www.kretinga.lt/skelbimai                                                 |
| Rietavo sav.      | https://www.rietavas.lt         | https://www.rietavas.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas                |
| Skuodo r. sav.    | https://www.skuodas.lt          | https://www.skuodas.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas                 |
| Tauragės r. sav.  | https://www.taurage.lt          | https://www.taurage.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas                 |
| Ukmergės r. sav.  | https://www.ukmerge.lt          | https://www.ukmerge.lt/skelbimai                                                  |
| Utenos r. sav.    | https://www.utena.lt            | https://www.utena.lt/?s=%C5%BEem%C4%97s%20paskirties%20keitimas                   |

## Nieko nerasta

Svetainė atsako, bet nei paieška, nei žinomos skiltys nieko negrąžino. Tai
**nereiškia**, kad savivaldybė neskelbia — žr. metodo ribas žemiau.

| Savivaldybė        | Svetainė                   |
| ------------------ | -------------------------- |
| Alytaus m. sav.    | https://www.alytus.lt      |
| Marijampolės sav.  | https://www.marijampole.lt |
| Klaipėdos m. sav.  | https://www.klaipeda.lt    |
| Neringos sav.      | https://www.neringa.lt     |
| Visagino sav.      | https://www.visaginas.lt   |
| Akmenės r. sav.    | https://www.akmene.lt      |
| Alytaus r. sav.    | https://www.arsa.lt        |
| Anykščių r. sav.   | https://www.anyksciai.lt   |
| Biržų r. sav.      | https://www.birzai.lt      |
| Elektrėnų sav.     | https://www.elektrenai.lt  |
| Zarasų r. sav.     | https://www.zarasai.lt     |
| Ignalinos r. sav.  | https://www.ignalina.lt    |
| Jonavos r. sav.    | https://www.jonava.lt      |
| Kėdainių r. sav.   | https://www.kedainiai.lt   |
| Kazlų Rūdos sav.   | https://www.kazluruda.lt   |
| Lazdijų r. sav.    | https://www.lazdijai.lt    |
| Mažeikių r. sav.   | https://www.mazeikiai.lt   |
| Molėtų r. sav.     | https://www.moletai.lt     |
| Plungės r. sav.    | https://www.plunge.lt      |
| Raseinių r. sav.   | https://www.raseiniai.lt   |
| Telšių r. sav.     | https://www.telsiai.lt     |
| Trakų r. sav.      | https://www.trakai.lt      |
| Šakių r. sav.      | https://www.sakiai.lt      |
| Šalčininkų r. sav. | https://www.salcininkai.lt |
| Šilutės r. sav.    | https://www.silute.lt      |
| Šiaulių r. sav.    | https://www.siauliuraj.lt  |
| Jurbarko r. sav.   | https://www.jurbarkas.lt   |

## Svetainės adresas neaiškus

Domenai spėjami iš pavadinimo. Rajonų savivaldybės nesilaiko vienos
konvencijos — `vrsa.lt`, `krs.lt`, `kaunorajonas.lt` ir `siauliuraj.lt` visi
realūs, todėl tikrinami visi tokie šablonai, o priimamas tik tas, kurio puslapis
įvardija tą pačią savivaldybę. Šioms nepasitvirtino nė vienas:

| Savivaldybė         |
| ------------------- |
| Palangos m. sav.    |
| Panevėžio m. sav.   |
| Vilkaviškio r. sav. |
| Joniškio r. sav.    |
| Kaišiadorių r. sav. |
| Kupiškio r. sav.    |
| Pakruojo r. sav.    |
| Panevėžio r. sav.   |
| Pasvalio r. sav.    |
| Radviliškio r. sav. |
| Rokiškio r. sav.    |
| Švenčionių r. sav.  |
| Širvintų r. sav.    |

## Metodo ribos

Skriptas turi savikontrolę: prieš apžvalgą patikrina, ar randa Vilnių —
vienintelį atvejį, kurį tikrai žinome. Pirmos trys versijos jo **nerado**, ir
kiekvieną kartą dėl skirtingos priežasties:

1. Ieškota per svetainės paiešką, o Vilnius skelbia naujienų kategorijoje.
2. Skelbimo tekstas yra **straipsnio viduje**, ne sąraše — reikėjo atidaryti
   straipsnius.
3. Ieškota frazės „žemės paskirties keitimas", o tikroji formuluotė yra
   „Esama pagrindinė žemės naudojimo paskirtis".

Dėl to prie „nieko nerasta" reikia elgtis atsargiai: tikrinamas ribotas adresų
rinkinys ir atidaroma tik po kelis straipsnius. Tai **trumpasis sąrašas, ne
išvada**.

## Ką daryčiau toliau

1. Rankomis suvesti 13 neaiškių savivaldybių domenus — be jų tiek pat
   savivaldybių lieka nepatikrinta.
2. Patikrinti, ar tos penkios WordPress savivaldybės turi vienodą straipsnio
   struktūrą. Jei taip — vienas skriptas su parametrais, o ne penki.
3. Tik tada rašyti nuskaitymą, pradedant nuo didžiausių savivaldybių.

Verta žinoti: Vilniaus integracija eina per Decodo rezidentinį proxy, nes
`vilnius.lt` blokuoja tiesiogines užklausas. Tikėtina, kad ir kitos savivaldybės
elgsis panašiai, tad į apimtį reikia įskaičiuoti proxy kaštus.
