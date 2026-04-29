import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerClassifier, classify, _resetClassifiersForTests } from '../../utils/classifiers';
import { INFOSTATYBA_SPEC, APP_TYPE_INFOSTATYBA } from '../../utils/classifiers/infostatyba';
import type { ClassifierSpec } from '../../utils/classifiers/types';

const APP = APP_TYPE_INFOSTATYBA;

describe('infostatyba classifier', () => {
  before(() => {
    _resetClassifiersForTests();
    registerClassifier(INFOSTATYBA_SPEC);
  });

  describe('specificity ordering — gyvenamieji', () => {
    it('matches daugiabutis before dvibutis/vienbutis/gyv_kita', () => {
      assert.equal(classify(APP, { name: 'Daugiabutis gyvenamasis namas' }), 'daugiabutis');
    });
    it('matches dvibutis before vienbutis', () => {
      assert.equal(classify(APP, { name: 'Dvibutis gyvenamasis namas' }), 'dvibutis');
      assert.equal(classify(APP, { name: 'Sublokuotas gyvenamasis namas' }), 'dvibutis');
    });
    it('matches vienbutis', () => {
      assert.equal(classify(APP, { name: 'Vienbutis gyvenamasis namas' }), 'vienbutis');
    });
    it('falls through to gyv_kita for generic gyvenamasis', () => {
      assert.equal(classify(APP, { name: 'Gyvenamasis namas' }), 'gyv_kita');
    });
    it('treats bare "Butas" as daugiabutis', () => {
      assert.equal(classify(APP, { name: 'Butas, Vilniaus g. 5' }), 'daugiabutis');
    });
    it('treats sodo-prefixed names as sodo_namelis', () => {
      assert.equal(classify(APP, { name: 'Sodo namelis' }), 'sodo_namelis');
      assert.equal(classify(APP, { name: 'Sodo pastatas' }), 'sodo_namelis');
    });
  });

  describe('tinklai vs komerciniai precedence', () => {
    it('classifies vandentiekio prekybos centras as vandentiekis (network), not prekyba', () => {
      assert.equal(
        classify(APP, { name: 'Vandentiekio tinklai prekybos centrui' }),
        'vandentiekis',
      );
    });
    it('classifies dujotiekis as dujos', () => {
      assert.equal(classify(APP, { name: 'Dujotiekis' }), 'dujos');
    });
    it('matches kV power lines as elektra', () => {
      assert.equal(classify(APP, { name: '110 kV oro linija' }), 'elektra');
    });
  });

  describe('energetika', () => {
    it('saulės elektrinė → saules_el', () => {
      assert.equal(classify(APP, { name: 'Saulės elektrinė' }), 'saules_el');
    });
    it('vėjo elektrinė → vejo_el', () => {
      assert.equal(classify(APP, { name: 'Vėjo elektrinė' }), 'vejo_el');
    });
    it('priešgaisrinis rezervuaras → siurbline', () => {
      assert.equal(classify(APP, { name: 'Priešgaisrinis rezervuaras' }), 'siurbline');
    });
  });

  describe('susisiekimas', () => {
    it('automobilių stovėjimo aikštelė → aikstele', () => {
      assert.equal(classify(APP, { name: 'Automobilių stovėjimo aikštelė' }), 'aikstele');
    });
    it('automobilių plovykla → garazas', () => {
      assert.equal(classify(APP, { name: 'Automobilių plovykla' }), 'garazas');
    });
  });

  describe('komerciniai', () => {
    it('viešbutis → viesbutis', () => {
      assert.equal(classify(APP, { name: 'Viešbutis "Lietuva"' }), 'viesbutis');
    });
    it('parduotuvė → prekyba', () => {
      assert.equal(classify(APP, { name: 'Parduotuvė' }), 'prekyba');
    });
    it('garažas → garazas', () => {
      assert.equal(classify(APP, { name: 'Garažas' }), 'garazas');
    });
  });

  describe('žemės ūkio', () => {
    it('tvartas → tvartas', () => {
      assert.equal(classify(APP, { name: 'Karvidė' }), 'tvartas');
    });
    it('šiltnamis → siltnamis', () => {
      assert.equal(classify(APP, { name: 'Šiltnamis' }), 'siltnamis');
    });
  });

  describe('Lithuanian diacritic case folding', () => {
    it('matches uppercase Š/Ž/Č as lowercase', () => {
      assert.equal(classify(APP, { name: 'ŠILTNAMIS' }), 'siltnamis');
      assert.equal(classify(APP, { name: 'DARŽINĖ' }), 'darzine');
      assert.equal(classify(APP, { name: 'BAŽNYČIA' }), 'religija');
    });
  });

  describe('specialization (body)', () => {
    it('refines pagalbinis_ukio → malkine when body says malkinė', () => {
      assert.equal(
        classify(APP, {
          name: 'Pagalbinio ūkio pastatas',
          body: '**Statinio pavadinimas**: Malkinė',
        }),
        'malkine',
      );
    });
    it('refines pagalbinis_ukio → tvartas via body', () => {
      assert.equal(
        classify(APP, {
          name: 'Pagalbinio ūkio pastatas',
          body: 'Statinio pavadinimas: Karvidė',
        }),
        'tvartas',
      );
    });
    it('leaves pagalbinis_ukio alone if body has no specializer', () => {
      assert.equal(
        classify(APP, { name: 'Pagalbinio ūkio pastatas', body: 'Some unrelated body' }),
        'pagalbinis_ukio',
      );
    });
  });

  describe('default fallthrough', () => {
    it('returns nepriskirta when nothing matches', () => {
      assert.equal(
        classify(APP, { name: 'Kažkokia visiškai nesusijusi paskirtis' }),
        'nepriskirta',
      );
    });
    it('handles empty/missing input safely', () => {
      assert.equal(classify(APP, { name: '' }), 'nepriskirta');
      assert.equal(classify(APP, { name: null, body: null }), 'nepriskirta');
    });
  });

  describe('registry behavior', () => {
    it('returns null for unregistered appType', () => {
      assert.equal(classify('not-a-real-app-type', { name: 'whatever' }), null);
    });
  });
});

describe('classifier registry validation', () => {
  beforeEach(() => _resetClassifiersForTests());

  it('throws on duplicate category code', () => {
    const bad: ClassifierSpec = {
      appType: 'x',
      defaultWhenNoMatch: 'a',
      categories: [
        { code: 'a', name: 'A', parent: null, sort: 1 },
        { code: 'a', name: 'A2', parent: null, sort: 2 },
      ],
      rules: [],
    };
    assert.throws(() => registerClassifier(bad), /duplicate category code/);
  });

  it('throws on unknown parent reference', () => {
    const bad: ClassifierSpec = {
      appType: 'x',
      defaultWhenNoMatch: 'a',
      categories: [
        { code: 'a', name: 'A', parent: null, sort: 1 },
        { code: 'b', name: 'B', parent: 'ghost', sort: 2 },
      ],
      rules: [],
    };
    assert.throws(() => registerClassifier(bad), /parent ghost does not exist/);
  });

  it('throws on rule pointing at unknown category', () => {
    const bad: ClassifierSpec = {
      appType: 'x',
      defaultWhenNoMatch: 'a',
      categories: [{ code: 'a', name: 'A', parent: null, sort: 1 }],
      rules: [{ pattern: /foo/, category: 'ghost' }],
    };
    assert.throws(() => registerClassifier(bad), /unknown category: ghost/);
  });

  it('throws on bad defaultWhenNoMatch', () => {
    const bad: ClassifierSpec = {
      appType: 'x',
      defaultWhenNoMatch: 'ghost',
      categories: [{ code: 'a', name: 'A', parent: null, sort: 1 }],
      rules: [],
    };
    assert.throws(() => registerClassifier(bad), /defaultWhenNoMatch ghost/);
  });

  it('throws on specialization referencing unknown whenCategory', () => {
    const bad: ClassifierSpec = {
      appType: 'x',
      defaultWhenNoMatch: 'a',
      categories: [{ code: 'a', name: 'A', parent: null, sort: 1 }],
      rules: [],
      specialization: [
        { whenCategory: 'ghost', matchField: 'body', rules: [{ pattern: /x/, category: 'a' }] },
      ],
    };
    assert.throws(() => registerClassifier(bad), /whenCategory ghost unknown/);
  });

  it('accepts a well-formed spec', () => {
    const ok: ClassifierSpec = {
      appType: 'x',
      defaultWhenNoMatch: 'a',
      categories: [
        { code: 'a', name: 'A', parent: null, sort: 1 },
        { code: 'b', name: 'B', parent: 'a', sort: 2 },
      ],
      rules: [{ pattern: /\bbee\b/i, category: 'b' }],
    };
    assert.doesNotThrow(() => registerClassifier(ok));
    assert.equal(classify('x', { name: 'a bee here' }), 'b');
    assert.equal(classify('x', { name: 'something else' }), 'a');
  });
});
