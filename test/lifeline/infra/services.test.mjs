import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defineDependencies, facilities } from '../../../src/lifeline/kernel/services.mjs';

const CATALOG = JSON.parse(readFileSync(new URL('../../../fixtures/lifeline/infra/town/dependencies.json', import.meta.url), 'utf8'));

test('the town dependency catalog declares every edge completely', () => {
  assert.deepEqual(defineDependencies(CATALOG), { ok: true, code: 'ok', edges: CATALOG.edges.length });
});

test('incomplete, duplicated, same-domain or non-canonical edges are refused', () => {
  const edge = CATALOG.edges.find(e => e.kind === 'physical_load');
  const cases = [
    [[edge, edge], 'duplicate_edge'],
    [[{ ...edge, evidence: [] }], 'missing_evidence'],
    [[(({ fallback, ...rest }) => rest)(edge)], 'missing_fallback'],
    [[{ ...edge, destination: { domain: 'water', asset: 'x' } }], 'not_cross_domain'],
    [[{ ...edge, units: 'kW' }], 'unit_not_canonical'],
    [[{ ...edge, efficiency: 1.4 }], 'invalid_efficiency'],
    [[{ ...edge, kind: 'vibes' }], 'unknown_edge_kind'],
  ];
  for (const [edges, code] of cases) assert.equal(defineDependencies({ edges }).code, code, code);
});

test('facility services stay separate components', () => {
  assert.deepEqual(facilities([{ serviceId: 'hospital-water', consumer: 'hospital' }, { serviceId: 'hospital-power', consumer: 'hospital' }, { serviceId: 'shelter-water', consumer: 'shelter' }]),
    { hospital: ['hospital-power', 'hospital-water'], shelter: ['shelter-water'] });
});
