import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

export const options = {
  stages: [
    { duration: '5s', target: 20 }, // Ramp up to 20 users
    { duration: '15s', target: 20 }, // Stay at 20 users
    { duration: '5s', target: 0 },  // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(99)<1000'], // 99% of requests must complete below 1000ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  // Deterministic values using VU ID and iteration, to avoid 409 duplicate errors
  // but still provide unique enough data across iterations
  const uniqueId = exec.vu.idInTest * 1000000 + exec.vu.iterationInInstance;
  const hexId = uniqueId.toString(16).padStart(40, '0');
  
  // Happy Path: valid attestation creation
  const payload = JSON.stringify({
    bondId: uniqueId,
    attesterAddress: '0x1234567890123456789012345678901234567890',
    subject: `0x${hexId}`,
    value: 'load_test_value',
    score: 100
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': 'load-test-tenant'
    },
  };

  const res = http.post(`${BASE_URL}/api/attestations`, payload, params);

  check(res, {
    'happy path: is status 201': (r) => r.status === 201 || r.status === 409, // Accept 409 in case of seed collisions on high load
  });

  // Explicit Sad Path: missing bondId and attesterAddress
  const sadPayload = JSON.stringify({
    subject: `0x${hexId}`,
    value: 'invalid_attestation'
  });

  const sadRes = http.post(`${BASE_URL}/api/attestations`, sadPayload, params);
  
  check(sadRes, {
    'sad path: is status 400 validation error': (r) => r.status === 400,
  });

  sleep(0.1);
}
