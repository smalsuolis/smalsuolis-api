import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lumberingIntensity } from '../utils/lumberingIntensity';

describe('how much of a permitted stand a cut actually clears', () => {
  it('takes the whole stand for a clear cut', () => {
    assert.equal(lumberingIntensity('Plynas kirtimas'), 1);
    assert.equal(lumberingIntensity('Plynas sanitarinis kirtimas'), 1);
    assert.equal(lumberingIntensity('Plynas sanitarinis kirtimas (stich. nelaim. atv.)'), 1);
    assert.equal(lumberingIntensity('Miško lydimo kirtimas'), 1);
  });

  it('takes half for a shelterwood cut', () => {
    assert.equal(lumberingIntensity('Atvejinis kirtimas'), 0.5);
    assert.equal(lumberingIntensity('Atvejinių miško kirtimų paskutinis atvejis'), 0.5);
    assert.equal(lumberingIntensity('Supaprastintas atvejinis kirtimas (Labanausko)'), 0.5);
  });

  it('takes a quarter for every thinning and tending cut', () => {
    for (const name of [
      'Atrankinis kirtimas',
      'Atrankinis sanitarinis kirtimas',
      'Jaunuolynų ugdymas',
      'Einamasis kirtimas',
      'Retinimas',
      'Kiti specialieji miško kirtimai (savo reikmėms)',
      'Kiti specialieji miško kirtimai (tarp. naud.)',
      'Kiti specialieji miško kirtimai (pagr. naud.)',
      'Medynų ir krūmynų pertvarkymo kirtimas',
      'Ribinių linijų kirtimas',
      'Biologinės įvairovės palaikymo miško kirtimas',
      'Kraštovaizdžio formavimo miško kirtimas',
    ]) {
      assert.equal(lumberingIntensity(name), 0.25, name);
    }
  });

  // The one name that breaks substring matching: it contains "plynais", so an
  // `includes('Plynas')`-style rule would hand a thinning cut a 100 % weight.
  it('does not mistake a cut named "neplynaisiais" for a clear cut', () => {
    assert.equal(
      lumberingIntensity(
        'Kiti specialieji miško kirtimai (Bt, D, Gl, Bl kirtimas neplynaisiais kirtimais)',
      ),
      0.25,
    );
  });

  it('falls back to a quarter for a name the feed has not used before', () => {
    assert.equal(lumberingIntensity('Visiškai naujas kirtimo tipas'), 0.25);
    assert.equal(lumberingIntensity(''), 0.25);
  });
});
