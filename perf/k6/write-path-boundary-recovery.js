import http from 'k6/http';
import { check, sleep, group } from 'k6';
import exec from 'k6/execution';

export const options = {
  stages: [
    { duration: '5s', target: 10 },
    { duration: '15s', target: 10 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(99)<2000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.95'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const VALID_TENANT = 'load-test-tenant';

function makeHeaders(tenantId = VALID_TENANT, apiKey = '') {
  const headers = {
    'Content-Type': 'application/json',
    'x-tenant-id': tenantId,
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  return headers;
}

function generateUniqueSubject(vuId, iteration, suffix = '') {
  const uniqueId = vuId * 1000000 + iteration;
  const hexId = uniqueId.toString(16).padStart(40, '0');
  return `0x${hexId}${suffix}`;
}

function buildPayload(overrides = {}) {
  const uniqueId = exec.vu.idInTest * 1000000 + exec.vu.iterationInInstance;
  const hexId = uniqueId.toString(16).padStart(40, '0');
  
  return JSON.stringify({
    bondId: uniqueId,
    attesterAddress: '0x1234567890123456789012345678901234567890',
    subject: `0x${hexId}`,
    value: 'load_test_value',
    score: 100,
    ...overrides,
  });
}

function postAttestation(payload, params) {
  return http.post(`${BASE_URL}/api/attestations`, payload, params);
}

export default function () {
  const params = { headers: makeHeaders() };
  const vuId = exec.vu.idInTest;
  const iteration = exec.vu.iterationInInstance;

  group('Happy Path: Valid Attestation Creation', () => {
    const payload = buildPayload();
    const res = postAttestation(payload, params);
    
    check(res, {
      'happy path: is status 201': (r) => r.status === 201,
      'happy path: has id in response': (r) => {
        try {
          const body = JSON.parse(r.body);
          return typeof body.id === 'number' && body.id > 0;
        } catch {
          return false;
        }
      },
      'happy path: returns correct fields': (r) => {
        try {
          const body = JSON.parse(r.body);
          return (
            body.bondId === exec.vu.idInTest * 1000000 + exec.vu.iterationInInstance &&
            body.attesterAddress === '0x1234567890123456789012345678901234567890' &&
            body.score === 100
          );
        } catch {
          return false;
        }
      },
    });
  });

  group('Boundary: Score at Minimum (0)', () => {
    const payload = buildPayload({ score: 0 });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary score 0: is status 201': (r) => r.status === 201,
      'boundary score 0: returns score 0': (r) => {
        try {
          return JSON.parse(r.body).score === 0;
        } catch {
          return false;
        }
      },
    });
  });

  group('Boundary: Score at Maximum (100)', () => {
    const payload = buildPayload({ score: 100 });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary score 100: is status 201': (r) => r.status === 201,
      'boundary score 100: returns score 100': (r) => {
        try {
          return JSON.parse(r.body).score === 100;
        } catch {
          return false;
        }
      },
    });
  });

  group('Boundary: Score Below Minimum (-1)', () => {
    const payload = buildPayload({ score: -1 });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary score -1: is status 400': (r) => r.status === 400,
      'boundary score -1: has validation error': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error === 'Validation failed' && Array.isArray(body.details);
        } catch {
          return false;
        }
      },
    });
  });

  group('Boundary: Score Above Maximum (101)', () => {
    const payload = buildPayload({ score: 101 });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary score 101: is status 400': (r) => r.status === 400,
      'boundary score 101: has validation error': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error === 'Validation failed';
        } catch {
          return false;
        }
      },
    });
  });

  group('Boundary: Value at Minimum Length (1 char)', () => {
    const payload = buildPayload({ value: 'x' });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary value 1 char: is status 201': (r) => r.status === 201,
    });
  });

  group('Boundary: Value at Maximum Length (2048 chars)', () => {
    const payload = buildPayload({ value: 'x'.repeat(2048) });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary value 2048 chars: is status 201': (r) => r.status === 201,
    });
  });

  group('Boundary: Value Exceeds Maximum (2049 chars)', () => {
    const payload = buildPayload({ value: 'x'.repeat(2049) });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary value 2049 chars: is status 400': (r) => r.status === 400,
      'boundary value 2049 chars: has validation error': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error === 'Validation failed';
        } catch {
          return false;
        }
      },
    });
  });

  group('Boundary: Key at Maximum Length (128 chars)', () => {
    const payload = buildPayload({ key: 'k'.repeat(128) });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary key 128 chars: is status 201': (r) => r.status === 201,
    });
  });

  group('Boundary: Key Exceeds Maximum (129 chars)', () => {
    const payload = buildPayload({ key: 'k'.repeat(129) });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary key 129 chars: is status 400': (r) => r.status === 400,
    });
  });

  group('Boundary: Subject Address - Valid Ethereum (lowercase)', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'lower');
    const payload = buildPayload({ subject });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary subject lowercase: is status 201': (r) => r.status === 201,
    });
  });

  group('Boundary: Subject Address - Valid Ethereum (uppercase)', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'upper').toUpperCase();
    const payload = buildPayload({ subject });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary subject uppercase: is status 201': (r) => r.status === 201,
      'boundary subject uppercase: normalized to lowercase': (r) => {
        try {
          return JSON.parse(r.body).subjectAddress === subject.toLowerCase();
        } catch {
          return false;
        }
      },
    });
  });

  group('Boundary: Subject Address - Valid Stellar (G-address)', () => {
    const stellarSubject = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const payload = buildPayload({ subject: stellarSubject });
    const res = postAttestation(payload, params);
    
    check(res, {
      'boundary subject stellar: is status 201': (r) => r.status === 201,
    });
  });

  group('Invalid Input: Malformed Ethereum Address (too short)', () => {
    const payload = buildPayload({ subject: '0x123' });
    const res = postAttestation(payload, params);
    
    check(res, {
      'invalid subject short: is status 400': (r) => r.status === 400,
      'invalid subject short: has validation error': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error === 'Validation failed';
        } catch {
          return false;
        }
      },
    });
  });

  group('Invalid Input: Malformed Ethereum Address (invalid hex)', () => {
    const payload = buildPayload({ subject: '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG' });
    const res = postAttestation(payload, params);
    
    check(res, {
      'invalid subject hex: is status 400': (r) => r.status === 400,
    });
  });

  group('Invalid Input: Invalid Stellar Address', () => {
    const payload = buildPayload({ subject: 'GINVALID' });
    const res = postAttestation(payload, params);
    
    check(res, {
      'invalid stellar: is status 400': (r) => r.status === 400,
    });
  });

  group('Invalid Input: Missing Required Fields (bondId)', () => {
    const payload = JSON.stringify({
      attesterAddress: '0x1234567890123456789012345678901234567890',
      subject: generateUniqueSubject(vuId, iteration),
      value: 'test',
      score: 50,
    });
    const res = postAttestation(payload, params);
    
    check(res, {
      'missing bondId: is status 400': (r) => r.status === 400,
      'missing bondId: error mentions bondId': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error === 'Validation failed' &&
            body.details.some((d) => d.path === 'bondId');
        } catch {
          return false;
        }
      },
    });
  });

  group('Invalid Input: Missing Required Fields (attesterAddress)', () => {
    const payload = JSON.stringify({
      bondId: vuId * 1000000 + iteration,
      subject: generateUniqueSubject(vuId, iteration),
      value: 'test',
      score: 50,
    });
    const res = postAttestation(payload, params);
    
    check(res, {
      'missing attesterAddress: is status 400': (r) => r.status === 400,
      'missing attesterAddress: error mentions attesterAddress': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error === 'Validation failed' &&
            body.details.some((d) => d.path === 'attesterAddress');
        } catch {
          return false;
        }
      },
    });
  });

  group('Invalid Input: Missing Required Fields (subject)', () => {
    const payload = JSON.stringify({
      bondId: vuId * 1000000 + iteration,
      attesterAddress: '0x1234567890123456789012345678901234567890',
      value: 'test',
      score: 50,
    });
    const res = postAttestation(payload, params);
    
    check(res, {
      'missing subject: is status 400': (r) => r.status === 400,
    });
  });

  group('Invalid Input: Missing Required Fields (value)', () => {
    const payload = JSON.stringify({
      bondId: vuId * 1000000 + iteration,
      attesterAddress: '0x1234567890123456789012345678901234567890',
      subject: generateUniqueSubject(vuId, iteration),
      score: 50,
    });
    const res = postAttestation(payload, params);
    
    check(res, {
      'missing value: is status 400': (r) => r.status === 400,
    });
  });

  group('Invalid Input: Missing Both bondId and attesterAddress', () => {
    const payload = JSON.stringify({
      subject: generateUniqueSubject(vuId, iteration),
      value: 'test',
    });
    const res = postAttestation(payload, params);
    
    check(res, {
      'missing both: is status 400': (r) => r.status === 400,
      'missing both: errors for both fields': (r) => {
        try {
          const body = JSON.parse(r.body);
          const paths = body.details.map((d) => d.path);
          return paths.includes('bondId') && paths.includes('attesterAddress');
        } catch {
          return false;
        }
      },
    });
  });

  group('Invalid Input: Empty Value String', () => {
    const payload = buildPayload({ value: '' });
    const res = postAttestation(payload, params);
    
    check(res, {
      'empty value: is status 400': (r) => r.status === 400,
    });
  });

  group('Invalid Input: Unexpected Extra Field', () => {
    const payload = buildPayload({ unexpectedField: 'not-allowed' });
    const res = postAttestation(payload, params);
    
    check(res, {
      'unexpected field: is status 400': (r) => r.status === 400,
    });
  });

  sleep(0.1);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(data),
  };
}

function textSummary(data, options = {}) {
  const { indent = '', enableColors = false } = options;
  const metrics = data.metrics;
  let output = '\n';
  
  output += `${indent}=== K6 Test Summary ===\n`;
  output += `${indent}Total Requests: ${metrics.http_reqs?.values?.count || 0}\n`;
  output += `${indent}Failed Requests: ${metrics.http_req_failed?.values?.passes || 0}\n`;
  output += `${indent}Avg Duration: ${(metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms\n`;
  output += `${indent}p(99) Duration: ${(metrics.http_req_duration?.values?.['p(99)'] || 0).toFixed(2)}ms\n`;
  output += `${indent}Checks Passed: ${(metrics.checks?.values?.passes || 0)}/${(metrics.checks?.values?.passes || 0) + (metrics.checks?.values?.fails || 0)}\n`;
  
  return output;
}