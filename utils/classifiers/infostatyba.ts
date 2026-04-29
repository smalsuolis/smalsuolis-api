// Classifier spec for infostatyba events (app_type = 'infostatyba').
//
// Ported from client's v1 spec (2026-04-28). Rule order is significant:
// first match wins. More specific rules must precede generic ones — the
// `daugiabutis` → `dvibutis` → `vienbutis` → `gyv_kita` ordering is the
// canonical example; do not reorder without updating the unit tests.
//
// Patterns use the `iu` flags (case-insensitive + Unicode) so that
// Lithuanian diacritics (š/ž/č/ą/ę/ė/į/ų/ū) fold correctly. POSIX
// `\m`/`\M` from the source spec map to JS `\b`.

import type { ClassifierSpec } from './types';

export const APP_TYPE_INFOSTATYBA = 'infostatyba';

export const INFOSTATYBA_SPEC: ClassifierSpec = {
  appType: APP_TYPE_INFOSTATYBA,
  defaultWhenNoMatch: 'nepriskirta',

  categories: [
    // Level 1
    { code: 'pastatai', name: 'Pastatai', parent: null, sort: 1 },
    { code: 'inzineriniai', name: 'Inžineriniai statiniai', parent: null, sort: 2 },
    { code: 'kita', name: 'Kita / nepriskirta', parent: null, sort: 9 },

    // Level 2 — pastatai
    { code: 'gyvenamieji', name: 'Gyvenamieji pastatai', parent: 'pastatai', sort: 1 },
    { code: 'komerciniai', name: 'Komerciniai pastatai', parent: 'pastatai', sort: 2 },
    { code: 'visuomeniniai', name: 'Visuomeniniai pastatai', parent: 'pastatai', sort: 3 },
    { code: 'pramoniniai', name: 'Pramonės ir sandėliavimo', parent: 'pastatai', sort: 4 },
    { code: 'zemes_ukio', name: 'Žemės ūkio pastatai', parent: 'pastatai', sort: 5 },
    { code: 'poilsio', name: 'Poilsio pastatai', parent: 'pastatai', sort: 6 },
    { code: 'pagalbiniai', name: 'Pagalbiniai / nesudėtingi', parent: 'pastatai', sort: 7 },

    // Level 2 — inzineriniai
    { code: 'susisiekimas', name: 'Susisiekimo statiniai', parent: 'inzineriniai', sort: 1 },
    { code: 'tinklai', name: 'Inžineriniai tinklai', parent: 'inzineriniai', sort: 2 },
    { code: 'energetika', name: 'Energetika', parent: 'inzineriniai', sort: 3 },
    { code: 'hidrotechnika', name: 'Hidrotechniniai', parent: 'inzineriniai', sort: 4 },

    // Level 3 — gyvenamieji
    { code: 'vienbutis', name: 'Vienbutis namas', parent: 'gyvenamieji', sort: 1 },
    { code: 'dvibutis', name: 'Dvibutis / sublokuotas', parent: 'gyvenamieji', sort: 2 },
    { code: 'daugiabutis', name: 'Daugiabutis', parent: 'gyvenamieji', sort: 3 },
    { code: 'bendrabutis', name: 'Bendrabutis / soc. grupėms', parent: 'gyvenamieji', sort: 4 },
    { code: 'sodo_namelis', name: 'Sodo namelis / sezoninis', parent: 'gyvenamieji', sort: 5 },
    { code: 'gyv_kita', name: 'Gyvenamasis (be tipo)', parent: 'gyvenamieji', sort: 9 },

    // Level 3 — komerciniai
    { code: 'biuras', name: 'Biurai / administraciniai', parent: 'komerciniai', sort: 1 },
    { code: 'prekyba', name: 'Prekybos', parent: 'komerciniai', sort: 2 },
    { code: 'maitinimas', name: 'Maitinimo', parent: 'komerciniai', sort: 3 },
    { code: 'viesbutis', name: 'Viešbučiai / apgyvendinimo', parent: 'komerciniai', sort: 4 },
    { code: 'paslaugos', name: 'Paslaugų', parent: 'komerciniai', sort: 5 },
    { code: 'garazas', name: 'Garažai / autoservisai', parent: 'komerciniai', sort: 6 },

    // Level 3 — visuomeniniai
    { code: 'mokslo', name: 'Mokslo (mokyklos, darželiai)', parent: 'visuomeniniai', sort: 1 },
    { code: 'gydymas', name: 'Gydymo', parent: 'visuomeniniai', sort: 2 },
    { code: 'kultura', name: 'Kultūros', parent: 'visuomeniniai', sort: 3 },
    { code: 'sportas', name: 'Sporto', parent: 'visuomeniniai', sort: 4 },
    { code: 'religija', name: 'Religiniai', parent: 'visuomeniniai', sort: 5 },
    { code: 'speciali', name: 'Specialiosios paskirties', parent: 'visuomeniniai', sort: 6 },

    // Level 3 — pramoniniai
    { code: 'gamyba', name: 'Gamybos / pramonės', parent: 'pramoniniai', sort: 1 },
    { code: 'sandeliavimas', name: 'Sandėliavimo', parent: 'pramoniniai', sort: 2 },

    // Level 3 — zemes_ukio
    { code: 'tvartas', name: 'Fermos / tvartai', parent: 'zemes_ukio', sort: 1 },
    { code: 'darzine', name: 'Daržinės / grūdų sandėliai', parent: 'zemes_ukio', sort: 2 },
    { code: 'siltnamis', name: 'Šiltnamiai', parent: 'zemes_ukio', sort: 3 },

    // Level 3 — poilsio
    { code: 'asm_poilsis', name: 'Asmeninio poilsio (sodybos)', parent: 'poilsio', sort: 1 },
    { code: 'kom_poilsis', name: 'Komercinio poilsio (kempingai)', parent: 'poilsio', sort: 2 },

    // Level 3 — pagalbiniai
    { code: 'pagalbinis_ukio', name: 'Pagalbinio ūkio (bendra)', parent: 'pagalbiniai', sort: 1 },
    { code: 'tvora', name: 'Tvora', parent: 'pagalbiniai', sort: 2 },
    { code: 'stogine', name: 'Stoginė / pavėsinė', parent: 'pagalbiniai', sort: 3 },
    { code: 'terasa', name: 'Terasa', parent: 'pagalbiniai', sort: 4 },
    { code: 'pirtis', name: 'Pirtis', parent: 'pagalbiniai', sort: 5 },
    { code: 'atramine_siena', name: 'Atraminės sienelės', parent: 'pagalbiniai', sort: 6 },
    { code: 'malkine', name: 'Malkinė', parent: 'pagalbiniai', sort: 7 },
    { code: 'viraline', name: 'Viralinė / vasaros virtuvė', parent: 'pagalbiniai', sort: 8 },
    { code: 'dirbtuves', name: 'Dirbtuvės', parent: 'pagalbiniai', sort: 9 },

    // Level 3 — susisiekimas
    { code: 'keliai', name: 'Keliai / gatvės', parent: 'susisiekimas', sort: 1 },
    { code: 'gelezinkeliai', name: 'Geležinkeliai', parent: 'susisiekimas', sort: 2 },
    { code: 'oro_uostai', name: 'Oro uostai', parent: 'susisiekimas', sort: 3 },
    {
      code: 'vandens_uostai',
      name: 'Vandens uostai / prieplaukos',
      parent: 'susisiekimas',
      sort: 4,
    },
    { code: 'tiltai', name: 'Tiltai / viadukai / tuneliai', parent: 'susisiekimas', sort: 5 },
    { code: 'aikstele', name: 'Aikštelės / parkavimas', parent: 'susisiekimas', sort: 6 },
    { code: 'takas', name: 'Pėsčiųjų / dviračių takai', parent: 'susisiekimas', sort: 7 },

    // Level 3 — tinklai
    { code: 'vandentiekis', name: 'Vandentiekio tinklai', parent: 'tinklai', sort: 1 },
    { code: 'nuotekos', name: 'Nuotekų tinklai', parent: 'tinklai', sort: 2 },
    { code: 'siluma', name: 'Šilumos tinklai', parent: 'tinklai', sort: 3 },
    { code: 'dujos', name: 'Dujų tinklai', parent: 'tinklai', sort: 4 },
    { code: 'elektra', name: 'Elektros tinklai', parent: 'tinklai', sort: 5 },
    { code: 'rysiai', name: 'Ryšių / telekomunikacijų tinklai', parent: 'tinklai', sort: 6 },

    // Level 3 — energetika
    { code: 'saules_el', name: 'Saulės elektrinės', parent: 'energetika', sort: 1 },
    { code: 'vejo_el', name: 'Vėjo elektrinės', parent: 'energetika', sort: 2 },
    { code: 'katiline', name: 'Katilinės', parent: 'energetika', sort: 3 },
    { code: 'siurbline', name: 'Siurblinės', parent: 'energetika', sort: 4 },
    { code: 'transform', name: 'Transformatorinės / pastotės', parent: 'energetika', sort: 5 },
    { code: 'grezinys', name: 'Gręžiniai / artezinis', parent: 'energetika', sort: 6 },

    // Catch-all
    { code: 'nepriskirta', name: 'Nepriskirta', parent: 'kita', sort: 9 },
  ],

  // First pass — match against `events.name`. Order is significant.
  rules: [
    // Gyvenamieji — specifics before generics
    { pattern: /\b(daugiabu(t|č))/iu, category: 'daugiabutis' },
    { pattern: /\b(dvibu(t|č)|dviejų butų|sublokuot|blokuot)/iu, category: 'dvibutis' },
    { pattern: /\b(vienbu(t|č)|vieno buto|sublokuoti namai)/iu, category: 'vienbutis' },
    { pattern: /\b(bendrabu(t|č)|socialin(ėms|ems) grup)/iu, category: 'bendrabutis' },
    { pattern: /\b(sodo namel|sodo pastat|sezonin)/iu, category: 'sodo_namelis' },
    { pattern: /^\s*sodo\s/iu, category: 'sodo_namelis' },
    { pattern: /^\s*butas\b/iu, category: 'daugiabutis' },
    {
      pattern:
        /\b(gyvenamasis nam|gyvenamas nam|gyvenamoji|gyvenamos|gyvenamųjų|gyvenamojo|gyvenam.+pastat)/iu,
      category: 'gyv_kita',
    },

    // Tinklai (before pastatai — "prekybos" can mean a building or a network)
    { pattern: /\b(vandentiek|vandenteika|vandentieka)/iu, category: 'vandentiekis' },
    {
      pattern:
        /\b(nuotek|nuotėk|kanalizac|drenaž|paviršin.+nuotek|lietaus tinkl|lietaus nuotek|buitin.+nuotek)/iu,
      category: 'nuotekos',
    },
    {
      pattern: /\b(valymo įreng|valymo stot|biolog.+valym|septik|nuotek.+valym|valyklos)/iu,
      category: 'nuotekos',
    },
    {
      pattern:
        /\b(šilumos tinkl|šilumos tiekim|šilumotiek|šilumos punkt|šilumos kamer|šilumos vamzdyn)/iu,
      category: 'siluma',
    },
    {
      pattern: /\b(dujotiek|dujų tinkl|skirstomojo dujot|gamtin.+duj.+tinkl|naftos|degal|cng)/iu,
      category: 'dujos',
    },
    {
      pattern:
        /\b(elektros tinkl|elektros lin|elektros perdav|elektros kabel|kabel.+lin|orinė lin|ev įkrov)/iu,
      category: 'elektra',
    },
    { pattern: /\b(110|220|330|400)\s*kv\b/iu, category: 'elektra' },
    {
      pattern: /\b(ryš.+tinkl|ryš.+kabel|ryš.+kanalizac|telekom|optin.+kabel|šviesolaid)/iu,
      category: 'rysiai',
    },

    // Energetika
    {
      pattern: /\b(saulės elektrin|saulės jėgain|saulės modul|fotovolt|saulės parka|saulės)/iu,
      category: 'saules_el',
    },
    {
      pattern: /\b(vėjo elektrin|vėjo jėgain|vėjo parka|vėjo agregat|vėjo)/iu,
      category: 'vejo_el',
    },
    { pattern: /\b(katilin)/iu, category: 'katiline' },
    { pattern: /\b(siurblin)/iu, category: 'siurbline' },
    {
      pattern:
        /\b(priešgais.+rezervuar|priešgais.+vand|priešgais.+stot|priešgais.+pump|gaisrin.+rezervuar)/iu,
      category: 'siurbline',
    },
    {
      pattern: /\b(transformat|skirstom.+pastot|trans.+pastot|110\/(10|20)|330\/110)/iu,
      category: 'transform',
    },
    { pattern: /\b(artezin|gręžin|grežin|šachtin.+šulin|gręžtin)/iu, category: 'grezinys' },

    // Susisiekimas
    { pattern: /\b(geležinkel)/iu, category: 'gelezinkeliai' },
    { pattern: /\b(oro uost|aerodrom|kilimo tak)/iu, category: 'oro_uostai' },
    { pattern: /\b(uost|prieplauk|krantin|molas)/iu, category: 'vandens_uostai' },
    { pattern: /\b(tilt|viaduk|tunel|estakad)/iu, category: 'tiltai' },
    {
      pattern:
        /\bautomob.+(plovykl|savitarn|salon|diagnoz|aptarn|techn.+apžiūr|techn.+aptarn|patikr|svarstykl|švaros|kontrol.+praleidim)/iu,
      category: 'garazas',
    },
    {
      pattern:
        /\bautomob.+(stovėjim|aikštel|aukštel|aikšel|aištel|vieta|vietų|keliai|aikšet|patikrinim.+pastoge)/iu,
      category: 'aikstele',
    },
    {
      pattern: /\b(stovėjim.+aikštel|parkavim|automob.+saugykl|aikštelė|kiemo aikštel)/iu,
      category: 'aikstele',
    },
    {
      pattern: /\b(pėsčiųjų tak|pėsč.+dvirač|dviračių tak|takas|takai|pėsčiųjų)/iu,
      category: 'takas',
    },
    {
      pattern: /\b(gatv|kelias|kelio rekonstr|privažiav|pravažiav|nuovaž|įvažiav)/iu,
      category: 'keliai',
    },

    // Hidrotechnika
    {
      pattern: /\b(užtvank|hidrotechn|tven kin|vandens tels|melioracij|polderis)/iu,
      category: 'hidrotechnika',
    },

    // Komerciniai
    { pattern: /\b(viešbut|hotel|motel|svečių nam)/iu, category: 'viesbutis' },
    { pattern: /\b(restoran|kavin|valgykl|maitinim|baras\b)/iu, category: 'maitinimas' },
    {
      pattern: /\b(parduotuv|prekyb|prekybin|prekybos centr|aikštel.+turg)/iu,
      category: 'prekyba',
    },
    {
      pattern: /\b(autoservis|automob.+servis|automob.+remont|techn.+apžiūr.+stot)/iu,
      category: 'garazas',
    },
    { pattern: /\b(garaž)/iu, category: 'garazas' },
    { pattern: /\b(administracin|biur|ofis|kontor)/iu, category: 'biuras' },
    { pattern: /\b(paslaug.+pastat|paslaug.+paskirti)/iu, category: 'paslaugos' },

    // Visuomeniniai
    {
      pattern: /\b(mokykl|darżel|darželi|lopšel|gimnazij|universitet|kolegij|akademij|mokslo)/iu,
      category: 'mokslo',
    },
    {
      pattern: /\b(ligonin|poliklinik|klinik|ambulatorij|sveikatos|gydym|odontolog|reabilitac)/iu,
      category: 'gydymas',
    },
    {
      pattern: /\b(muziej|teatr|biblio|kult|koncert|kino|galerij|paroda)/iu,
      category: 'kultura',
    },
    {
      pattern: /\b(sporto|stadion|baseinas|baseino|sporto sal|sporto aikštel|gimnastik)/iu,
      category: 'sportas',
    },
    { pattern: /\b(bažnyč|klebonij|parapij|cerkv|sinagog|religin)/iu, category: 'religija' },
    {
      pattern:
        /\b(gaisrin|gelbėjim|policij|kareiv|kalėjim|specialiosios paskirti|specialios paskirti|special.+paslaug)/iu,
      category: 'speciali',
    },

    // Pramonė
    { pattern: /\b(sandėliav|sandėl|saugykl)/iu, category: 'sandeliavimas' },
    { pattern: /\b(gamybin|gamybos|gamyba|pramon|fabrik|cech\b|dirbtuv)/iu, category: 'gamyba' },

    // Žemės ūkis
    {
      pattern: /\b(tvart|karvid|kiaulid|paukštid|fermos paskir|ferma\b|fermų)/iu,
      category: 'tvartas',
    },
    { pattern: /\b(daržin|grūd|šiaud|kluonas|svirn)/iu, category: 'darzine' },
    { pattern: /\b(šiltnami)/iu, category: 'siltnamis' },

    // Poilsis
    {
      pattern: /\b(kempin|poilsiavi|poilsio bazė|kaimo turizm|sodyb|svečių nam)/iu,
      category: 'kom_poilsis',
    },
    {
      pattern: /\b(asmenin.+poilsi|vasarnam|poilsio pastat|poilsio nam|poilsio paskir)/iu,
      category: 'asm_poilsis',
    },

    // Pagalbiniai
    { pattern: /\b(pirti)/iu, category: 'pirtis' },
    { pattern: /\b(atramin.+sien|atramin.+sienel)/iu, category: 'atramine_siena' },
    { pattern: /\b(stogin|pavėsin|pastogin)/iu, category: 'stogine' },
    { pattern: /\bteras/iu, category: 'terasa' },
    { pattern: /(^\s*tvora|\btvora\b)/iu, category: 'tvora' },
    {
      pattern:
        /\b(pagalbin.+ūkio|pagalbin.+pastat|ūkin.+pastat|ūkio pastat|malkin|viralin|viral)/iu,
      category: 'pagalbinis_ukio',
    },
  ],

  // Second pass — refine `pagalbinis_ukio` using `events.body`.
  specialization: [
    {
      whenCategory: 'pagalbinis_ukio',
      matchField: 'body',
      rules: [
        { pattern: /\b(malkin)/iu, category: 'malkine' },
        { pattern: /\b(viralin)/iu, category: 'viraline' },
        { pattern: /\b(pirti)/iu, category: 'pirtis' },
        { pattern: /\b(daržin)/iu, category: 'darzine' },
        { pattern: /\b(tvart|karvid|kiaulid|paukšt)/iu, category: 'tvartas' },
        { pattern: /\b(stogin|pavėsin)/iu, category: 'stogine' },
        { pattern: /\b(dirbtuv)/iu, category: 'dirbtuves' },
        { pattern: /\b(garaž)/iu, category: 'garazas' },
        { pattern: /\b(sandėl)/iu, category: 'sandeliavimas' },
      ],
    },
  ],
};
