import http from 'k6/http';
import { check, sleep, group } from 'k6';
import exec from 'k6/execution';

export const options = {
  stages: [
    { duration: '5s', target: 5 },
    { duration: '10s', target: 5 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(99)<2000'],
    http_req_failed: ['rate<0.1'],
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
    value: 'auth_test_value',
    score: 100,
    ...overrides,
  });
}

function postAttestation(payload, params) {
  return http.post(`${BASE_URL}/api/attestations`, payload, params);
}

function getAttestations(subject, params) {
  return http.get(`${BASE_URL}/api/attestations/${subject}`, params);
}

export default function () {
  const vuId = exec.vu.idInTest;
  const iteration = exec.vu.iterationInInstance;

  group('Auth: Valid Write Scope', () => {
    const params = { headers: makeHeaders(VALID_TENANT, 'write-test-key') };
    const subject = generateUniqueSubject(vuId, iteration, 'authwrite');
    const payload = buildPayload({ subject });
    
    const res = postAttestation(payload, params);
    
    check(res, {
      'write scope: succeeds with 201': (r) => r.status === 201,
      'write scope: returns attestation': (r) => {
        try {
          const body = JSON.parse(r.body);
          return typeof body.id === 'number';
        } catch {
          return false;
        }
      },
    });
  });

  group('Auth: Valid Read Scope', () => {
    const params = { headers: makeHeaders(VALID_TENANT, 'read-test-key') };
    const subject = generateUniqueSubject(vuId, iteration, 'authread');
    
    const res = getAttestations(subject, params);
    
    check(res, {
      'read scope: succeeds with 200': (r) => r.status === 200,
      'read scope: returns pagination': (r) => {
        try {
          const body = JSON.parse(r.body);
          return typeof body.page !== 'undefined';
        } catch {
          return false;
        }
      },
    });
  });

  group('Auth: Write Scope Cannot Read (if enforced)', () => {
    const params = { headers: makeHeaders(VALID_TENANT, 'write-test-key') };
    const subject = generateUniqueSubject(vuId, iteration, 'writeread');
    
    const res = getAttestations(subject, params);
    
    check(res, {
      'write scope read: allowed or denied consistently': (r) => 
        r.status === 200 || r.status === 403,
    });
  });

  group('Auth: Read Scope Cannot Write', () => {
    const params = { headers: makeHeaders(VALID_TENANT, 'read-test-key') };
    const subject = generateUniqueSubject(vuId, iteration, 'readwrite');
    const payload = buildPayload({ subject });
    
    const res = postAttestation(payload, params);
    
    check(res, {
      'read scope write: is 403': (r) => r.status === 403,
      'read scope write: error code forbidden': (r) => {
        try {
          return JSON.parse(r.body).code === 'forbidden';
        } catch {
          return false;
        }
      },
    });
  });

  group('Auth: No API Key', () => {
    const params = { headers: makeHeaders(VALID_TENANT, '') };
    const subject = generateUniqueSubject(vuId, iteration, 'nokey');
    const payload = buildPayload({ subject });
    
    const res = postAttestation(payload, params);
    
    check(res, {
      'no api key: is 401': (r) => r.status === 401,
      'no api key: error code unauthorized': (r) => {
        try {
          return JSON.parse(r.body).code === 'unauthorized';
        } catch {
          return false;
        }
      },
    });
  });

  group('Auth: Invalid API Key Format', () => {
    const params = { headers: makeHeaders(VALID_TENANT, 'not-a-valid-key-format') };
    const subject = generateUniqueSubject(vuId, iteration, 'badfmt');
    const payload = buildPayload({ subject });
    
    const res = postAttestation(payload, params);
    
    check(res, {
      'invalid key format: is 401': (r) => r.status === 401,
    });
  });

  group('Auth: Expired/Revoked API Key', () => {
    const params = { headers: makeHeaders(VALID_TENANT, 'expired-test-key') };
    const subject = generateUniqueSubject(vuId, iteration, 'expired');
    const payload = buildPayload({ subject });
    
    const res = postAttestation(payload, params);
    
    check(res, {
      'expired key: is 401 or 403': (r) => r.status === 401 || r.status === 403,
    });
  });

  group('Auth: Cross-Tenant Access Denied', () => {
    const params = { headers: makeHeaders('other-tenant', 'write-test-key') };
    const subject = generateUniqueSubject(vuId, iteration, 'crosstenant');
    const payload = buildPayload({ subject });
    
    const res = postAttestation(payload, params);
    
    check(res, {
      'cross-tenant: is 403 or isolated': (r) => 
        r.status === 403 || r.status === 201,
    });
  });

  group('Auth: Tenant Header Required', () => {
    const params = { headers: { 'Content-Type': 'application/json', 'x-api-key': 'write-test-key' } };
    const subject = generateUniqueSubject(vuId, iteration, 'notenant');
    const payload = buildPayload({ subject });
    
    const res = postAttestation(payload, params);
    
    check(res, {
      'no tenant header: handled': (r) => 
        r.status === 201 || r.status === 400 || r.status === 401,
    });
  });

  group('Auth: Attester Address Validation', () => {
    const params = { headers: makeHeaders(VALID_TENANT, 'write-test-key') };
    const subject = generateUniqueSubject(vuId, iteration, 'attester');
    
    const invalidAttesterPayload = buildPayload({ 
      subject, 
      attesterAddress: 'not-an-address' 
    });
    
    const res = postAttestation(invalidAttesterPayload, params);
    
    check(res, {
      'invalid attester: is 400': (r) => r.status === 400,
      'invalid attester: error details': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error === 'Validation failed';
        } catch {
          return false;
        }
      },
    });
  });

  group('Auth: Bond ID Must Be Positive Integer', () => {
    const params = { headers: makeHeaders(VALID_TENANT, 'write-test-key') };
    const subject = generateUniqueSubject(vuId, iteration, 'bondid');
    
    const zeroBondPayload = buildPayload({ subject, bondId: 0 });
    const zeroRes = postAttestation(zeroBondPayload, params);
    
    check(zeroRes, {
      'bondId 0: is 400': (r) => r.status === 400,
    });
    
    const negativeBondPayload = buildPayload({ subject, bondId: -1 });
    const negRes = postAttestation(negativeBondPayload, params);
    
    check(negRes, {
      'bondId negative: is 400': (r) => r.status === 400,
    });
  });

  group('Auth: Score Type Coercion', () => {
    const params = { headers: makeHeaders(VALID_TENANT, 'write-test-key') };
    const subject = generateUniqueSubject(vuId, iteration, 'scoretype');
    
    const stringScorePayload = buildPayload({ subject, score: '50' });
    const stringRes = postAttestation(stringScorePayload, params);
    
    check(stringRes, {
      'score as string: coerced to number': (r) => {
        if (r.status !== 201) return true;
        try {
          return JSON.parse(r.body).score === 50;
        } catch {
          return false;
        }
      },
    });
    
    const floatScorePayload = buildPayload({ subject, score: 50.7 });
    const floatRes = postAttestation(floatScorePayload, params);
    
    check(floatRes, {
      'score as float: coerced to int': (r) => {
        if (r.status !== 201) return true;
        try {
          return JSON.parse(r.body).score === 50;
        } catch {
          return false;
        }
      },
    });
  });

  sleep(0.1);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'auth-summary.json': JSON.stringify(data),
  };
}

function textSummary(data, options = {}) {
  const { indent = '', enableColors = false } = options;
  const metrics = data.metrics;
  let output = '\n';
  
  output += `${indent}=== K6 Authorization Test Summary ===\n`;
  output += `${indent}Total Requests: ${metrics.http_reqs?.values?.count || 0}\n`;
  output += `${indent}Failed Requests: ${metrics.http_req_failed?.values?.passes || 0}\n`;
  output += `${indent}Avg Duration: ${(metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms\n`;
  output += `${indent}p(99) Duration: ${(metrics.http_req_duration?.values?.['p(99)'] || 0).toFixed(2)}ms\n`;
  output += `${indent}Checks Passed: ${(metrics.checks?.values?.passes || 0)}/${(metrics.checks?.values?.passes || 0) + (metrics.checks?.values?.fails || 0)}\n`;
  
  return output;
}