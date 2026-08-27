import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeometry,
  ParcelLookup,
  ResolvedParcel,
} from '../../utils/savivaldybeZemetvarka/parcels';

const square = (x: number): any => ({
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [x, 0],
        [x + 1, 0],
        [x + 1, 1],
        [x, 1],
        [x, 0],
      ],
    ],
  },
});

const parcel = (cadastralNumber: string, municipalityCode: string, x = 0): ResolvedParcel => ({
  cadastralNumber,
  municipalityCode,
  municipalityName: `sav. ${municipalityCode}`,
  geometry: square(x),
});

const lookupOf = (entries: [string, ResolvedParcel][]): ParcelLookup => new Map(entries);

describe('building a notice geometry', () => {
  it('reports the cadastral number the registry returned, not the one written', () => {
    // A notice giving unique number 7240-0001-0086 is displayed with the
    // cadastral number that identifies the same parcel.
    const lookup = lookupOf([['724000010086', parcel('7240/0001:0086', '72')]]);
    const g = buildGeometry({ cadastrals: [], uniqueNumbers: ['724000010086'] }, lookup);
    assert.deepEqual(g?.cadastralNumbers, ['7240/0001:0086']);
  });

  it('merges several parcels into one geometry', () => {
    const lookup = lookupOf([
      ['4337/0005:0390', parcel('4337/0005:0390', '43', 0)],
      ['4337/0005:0391', parcel('4337/0005:0391', '43', 5)],
    ]);
    const g = buildGeometry(
      { cadastrals: ['4337/0005:0390', '4337/0005:0391'], uniqueNumbers: [] },
      lookup,
    );
    assert.ok(g?.geom);
    assert.equal(g!.cadastralNumbers.length, 2);
    assert.equal(g!.geom.geometry.crs, 'EPSG:4326');
  });

  it('drops a parcel the registry placed in another municipality', () => {
    // A parcel in the wrong municipality means the identifier was misread. Left
    // in, it puts the notice on someone else's map and into their subscription.
    const lookup = lookupOf([['4337/0005:0390', parcel('4337/0005:0390', '99')]]);
    const g = buildGeometry({ cadastrals: ['4337/0005:0390'], uniqueNumbers: [] }, lookup, '43');
    assert.equal(g, null);
    const kept = buildGeometry({ cadastrals: ['4337/0005:0390'], uniqueNumbers: [] }, lookup, '99');
    assert.ok(kept?.geom);
  });

  it('keeps the good parcels when only some are misplaced', () => {
    const lookup = lookupOf([
      ['4337/0005:0390', parcel('4337/0005:0390', '43', 0)],
      ['4337/0005:0391', parcel('4337/0005:0391', '99', 5)],
    ]);
    const g = buildGeometry(
      { cadastrals: ['4337/0005:0390', '4337/0005:0391'], uniqueNumbers: [] },
      lookup,
      '43',
    );
    assert.deepEqual(g?.cadastralNumbers, ['4337/0005:0390']);
    assert.deepEqual(g?.wrongMunicipality, ['4337/0005:0391']);
  });

  it('reports identifiers the registry did not recognise', () => {
    const g = buildGeometry({ cadastrals: ['1234/0001:0001'], uniqueNumbers: [] }, lookupOf([]));
    assert.equal(g, null);
  });

  it('counts the unresolved alongside the resolved', () => {
    const lookup = lookupOf([['4337/0005:0390', parcel('4337/0005:0390', '43')]]);
    const g = buildGeometry(
      { cadastrals: ['4337/0005:0390', '9999/0009:0009'], uniqueNumbers: [] },
      lookup,
    );
    assert.deepEqual(g?.unresolved, ['9999/0009:0009']);
  });
});
