import {
  formatTime,
  parseOpeningHours,
  serializeOpeningHours,
} from '../src/branches/opening-hours';
import {
  buildBranchInput,
  buildBranchPatch,
  emptyBranchFormValues,
  toBranchFormValues,
  type BranchFormValues,
} from '../src/pages/branches/branch-form';
import type { BranchRecord } from '../src/profile/contract';

const baseBranch: BranchRecord = {
  id: 'branch-1',
  label: 'Dubai Marina pool',
  addressLine: 'Marina Promenade, Block C',
  city: null,
  areaLabel: 'Dubai Marina',
  geoPoint: null,
  openingHours: null,
  facilities: ['Indoor pool', 'Parking'],
  active: true,
  version: 4,
};

describe('opening hours encoding (W2-5 recorded shape)', () => {
  test('round-trips the weekly shape and rejects everything else without crashing', () => {
    const weekly = { mon: { open: '06:00', close: '22:00' }, fri: { open: '08:00', close: '20:00' } };
    expect(parseOpeningHours(weekly)).toEqual(weekly);
    expect(serializeOpeningHours(weekly)).toEqual(weekly);
    expect(serializeOpeningHours({})).toBeNull();

    // Tolerant reads: unknown/legacy shapes are "not set", never a crash.
    expect(parseOpeningHours(null)).toBeNull();
    expect(parseOpeningHours('Daily · 6:00 AM – 11:00 PM')).toBeNull();
    expect(parseOpeningHours(['06:00'])).toBeNull();
    expect(parseOpeningHours({ mon: { open: '6am', close: '22:00' } })).toBeNull();
    expect(parseOpeningHours({ mon: { open: '25:00', close: '22:00' } })).toBeNull();
  });

  test('formats 24h times in provider-friendly 12h form', () => {
    expect(formatTime('06:05')).toBe('6:05 AM');
    expect(formatTime('00:15')).toBe('12:15 AM');
    expect(formatTime('12:00')).toBe('12:00 PM');
    expect(formatTime('22:30')).toBe('10:30 PM');
  });
});

describe('branch form → contract mapping (dirty-field discipline)', () => {
  test('buildBranchInput trims and omits optional empties', () => {
    const values = emptyBranchFormValues();
    values.label = '  JLT pool ';
    values.areaLabel = 'Jumeirah';
    const input = buildBranchInput(values);
    expect(input).toEqual({
      label: 'JLT pool',
      areaLabel: 'Jumeirah',
      addressLine: null,
      city: null,
    });
  });

  test('an untouched form produces an EMPTY patch', () => {
    const values = toBranchFormValues(baseBranch);
    expect(buildBranchPatch(values, baseBranch)).toEqual({});
  });

  test('only changed fields enter the patch — untouched fields are never sent', () => {
    const values = toBranchFormValues(baseBranch);
    values.label = 'Dubai Marina flagship pool';
    expect(buildBranchPatch(values, baseBranch)).toEqual({
      label: 'Dubai Marina flagship pool',
    });
  });

  test('clearing a nullable field sends null; setting hours sends the weekly shape', () => {
    const values = toBranchFormValues(baseBranch);
    values.addressLine = '   ';
    values.hours.sat = { enabled: true, open: '09:00', close: '18:00' };
    expect(buildBranchPatch(values, baseBranch)).toEqual({
      addressLine: null,
      openingHours: { sat: { open: '09:00', close: '18:00' } },
    });
  });

  test('an unrecognised stored hours value is preserved unless hours are actually edited', () => {
    const legacy: BranchRecord = { ...baseBranch, openingHours: 'Daily 6–11' };
    const values = toBranchFormValues(legacy);
    values.label = 'Renamed';
    // Hours untouched → the legacy value is NOT rewritten by this save.
    expect(buildBranchPatch(values, legacy)).toEqual({ label: 'Renamed' });
    // A deliberate hours edit replaces it with the recorded weekly shape.
    values.hours.mon = { enabled: true, open: '06:00', close: '11:00' };
    expect(buildBranchPatch(values, legacy)).toEqual({
      label: 'Renamed',
      openingHours: { mon: { open: '06:00', close: '11:00' } },
    });
  });

  test('geo edits compare numerically and clear to null as a pair', () => {
    const withGeo: BranchRecord = {
      ...baseBranch,
      geoPoint: { longitude: 55.14, latitude: 25.08 },
    };
    const values = toBranchFormValues(withGeo);
    expect(buildBranchPatch(values, withGeo)).toEqual({});
    values.latitude = '';
    values.longitude = '';
    expect(buildBranchPatch(values, withGeo)).toEqual({ geoPoint: null });
  });

  test('facility edits send the full normalized list', () => {
    const values: BranchFormValues = toBranchFormValues(baseBranch);
    values.facilities = ['Indoor pool', 'Parking', ' Café '];
    expect(buildBranchPatch(values, baseBranch)).toEqual({
      facilities: ['Indoor pool', 'Parking', 'Café'],
    });
  });
});
