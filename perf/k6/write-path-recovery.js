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
    http_req_duration: ['p(99)<3000'],
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.90'],
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
    value: 'recovery_test_value',
    score: 100,
    ...overrides,
  });
}

function postAttestation(payload, params) {
  return http.post(`${BASE_URL}/api/attestations`, payload, params);
}

function postAttestationWithRetry(payload, params, maxRetries = 3, retryDelay = 100) {
  let lastResponse;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResponse = postAttestation(payload, params);
    
    if (lastResponse.status >= 200 && lastResponse.status < 300) {
      return { response: lastResponse, attempts: attempt + 1, success: true };
    }
    
    if (lastResponse.status === 409 || lastResponse.status === 400) {
      return { response: lastResponse, attempts: attempt + 1, success: false, reason: 'non_retryable' };
    }
    
    if (attempt < maxRetries) {
      sleep(retryDelay / 1000);
    }
  }
  
  return { response: lastResponse, attempts: maxRetries + 1, success: false, reason: 'max_retries_exceeded' };
}

export default function () {
  const params = { headers: makeHeaders() };
  const vuId = exec.vu.idInTest;
  const iteration = exec.vu.iterationInInstance;

  group('Recovery: Duplicate Submission Returns 409', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'dup');
    const payload = buildPayload({ subject });
    
    const firstRes = postAttestation(payload, params);
    check(firstRes, {
      'first submission: is 201 or 409': (r) => r.status === 201 || r.status === 409,
    });
    
    if (firstRes.status === 201) {
      const secondRes = postAttestation(payload, params);
      check(secondRes, {
        'duplicate submission: is status 409': (r) => r.status === 409,
        'duplicate submission: error message correct': (r) => {
          try {
            return JSON.parse(r.body).error === 'Duplicate attestation';
          } catch {
            return false;
          }
        },
        'duplicate submission: has error code': (r) => {
          try {
            return JSON.parse(r.body).code === 'conflict';
          } catch {
            return false;
          }
        },
      });
    }
  });

  group('Recovery: Retry on Transient 5xx Errors', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'retry');
    const payload = buildPayload({ subject });
    
    const result = postAttestationWithRetry(payload, params, 3, 200);
    
    check(result, {
      'retry: eventually succeeds or fails gracefully': (r) => r.success || r.reason === 'non_retryable',
      'retry: attempts tracked': (r) => r.attempts >= 1 && r.attempts <= 4,
    });
  });

  group('Recovery: Idempotency - Same Payload Twice', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'idem');
    const payload = buildPayload({ subject });
    
    const res1 = postAttestation(payload, params);
    const res2 = postAttestation(payload, params);
    
    check(res1, {
      'idempotency first: is 201 or 409': (r) => r.status === 201 || r.status === 409,
    });
    
    check(res2, {
      'idempotency second: is 409 if first was 201': (r) => {
        if (res1.status === 201) return r.status === 409;
        return r.status === 409;
      },
      'idempotency second: same error code': (r) => {
        try {
          return JSON.parse(r.body).code === 'conflict';
        } catch {
          return false;
        }
      },
    });
  });

  group('Recovery: Concurrent Duplicate Submissions', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'conc');
    const payload = buildPayload({ subject });
    
    const responses = http.batch([
      ['POST', `${BASE_URL}/api/attestations`, payload, params],
      ['POST', `${BASE_URL}/api/attestations`, payload, params],
      ['POST', `${BASE_URL}/api/attestations`, payload, params],
    ]);
    
    const statuses = responses.map((r) => r.status);
    const successCount = statuses.filter((s) => s === 201).length;
    const conflictCount = statuses.filter((s) => s === 409).length;
    
    check(null, {
      'concurrent: exactly one succeeds': () => successCount === 1,
      'concurrent: rest get 409': () => conflictCount === 2,
      'concurrent: no 5xx errors': () => !statuses.some((s) => s >= 500),
    });
  });

  group('Recovery: Invalid Input Followed by Valid Input', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'valid_after_invalid');
    
    const invalidPayload = buildPayload({ subject, score: 101 });
    const invalidRes = postAttestation(invalidPayload, params);
    
    check(invalidRes, {
      'invalid first: is 400': (r) => r.status === 400,
    });
    
    const validPayload = buildPayload({ subject, score: 50 });
    const validRes = postAttestation(validPayload, params);
    
    check(validRes, {
      'valid after invalid: succeeds': (r) => r.status === 201,
      'valid after invalid: correct score': (r) => {
        try {
          return JSON.parse(r.body).score === 50;
        } catch {
          return false;
        }
      },
    });
  });

  group('Recovery: Missing Tenant Header', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'notenant');
    const payload = buildPayload({ subject });
    const noTenantParams = { headers: { 'Content-Type': 'application/json' } };
    
    const res = postAttestation(payload, noTenantParams);
    
    check(res, {
      'no tenant: handled gracefully': (r) => r.status === 201 || r.status === 400 || r.status === 401,
    });
  });

  group('Recovery: Invalid API Key', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'badkey');
    const payload = buildPayload({ subject });
    const badKeyParams = { headers: makeHeaders(VALID_TENANT, 'invalid-key') };
    
    const res = postAttestation(payload, badKeyParams);
    
    check(res, {
      'invalid api key: is 401 or 403': (r) => r.status === 401 || r.status === 403,
    });
  });

  group('Recovery: Wrong Scope (Read Scope for Write)', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'wrongscope');
    const payload = buildPayload({ subject });
    const readScopeParams = { headers: makeHeaders(VALID_TENANT, 'read-only-key') };
    
    const res = postAttestation(payload, readScopeParams);
    
    check(res, {
      'wrong scope: is 403': (r) => r.status === 403,
    });
  });

  group('Recovery: Large Payload Within Limits', () => {
    const subject = generateUniqueSubject(vuId, iteration, 'large');
    const payload = buildPayload({ 
      subject,
      value: 'x'.repeat(2000),
      key: 'k'.repeat(100),
    });
    const res = postAttestation(payload, params);
    
    check(res, {
      'large valid payload: succeeds': (r) => r.status === 201,
    });
  });

  group('Recovery: Rapid Sequential Requests', () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      const subject = generateUniqueSubject(vuId, iteration, `rapid${i}`);
      const payload = buildPayload({ subject });
      const res = postAttestation(payload, params);
      results.push(res.status);
      sleep(0.05);
    }
    
    const successCount = results.filter((s) => s === 201).length;
    const conflictCount = results.filter((s) => s === 409).length;
    
    check(null, {
      'rapid sequential: all succeed or conflict': () => 
        successCount + conflictCount === 5,
      'rapid sequential: no 5xx': () => 
        !results.some((s) => s >= 500),
    });
  });

  sleep(0.2);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'recovery-summary.json': JSON.stringify(data),
  };
}

function textSummary(data, options = {}) {
  const { indent = '', enableColors = false } = options;
  const metrics = data.metrics;
  let output = '\n';
  
  output += `${indent}=== K6 Recovery Test Summary ===\n`;
  output += `${indent}Total Requests: ${metrics.http_reqs?.values?.count || 0}\n`;
  output += `${indent}Failed Requests: ${metrics.http_req_failed?.values?.passes || 0}\n`;
  output += `${indent}Avg Duration: ${(metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms\n`;
  output += `${indent}p(99) Duration: ${(metrics.http_req_duration?.values?.['p(99)'] || 0).toFixed(2)}ms\n`;
  output += `${indent}Checks Passed: ${(metrics.checks?.values?.passes || 0)}/${(metrics.checks?.values?.passes || 0) + (metrics.checks?.values?.fails || 0)}\n`;
  
  return output;
}