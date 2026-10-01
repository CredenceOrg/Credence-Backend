import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

/**
 * k6 write-path load test for POST /api/attestations.
 *
 * The script exercises two flows per iteration:
 *
 *   1. happy path  – a well-formed attestation, expected to be created (201) or
 *                    to collide with an earlier submission (409);
 *   2. sad path    – a payload missing the required `bondId` and
 *                    `attesterAddress` fields, expected to be rejected (400).
 *
 * ## Invariants this module guarantees
 *
 * * **Deterministic inputs.** `uniqueId` is a pure function of the VU id and the
 *   per-VU iteration counter, so a given (VU, iteration) pair always produces
 *   byte-identical payloads. That keeps the 409 rate meaningful instead of
 *   random, and makes the suite below reproducible.
 * * **Valid subject width at any scale.** `subject` is always exactly 40 hex
 *   characters, so it stays a valid 20-byte identifier no matter how large the
 *   VU id and iteration counter grow.
 * * **Pacing is unconditional.** The per-iteration `sleep` runs even when a
 *   request throws, so a degraded service can never turn this generator into an
 *   unpaced hot loop.
 *
 * ## Testability
 *
 * The k6 built-ins (`k6`, `k6/http`, `k6/execution`) are only available inside
 * the k6 runtime. Everything that can be expressed as a pure function is
 * exported so `perf/k6/write-path.boundary.test.js` can cover the boundary and
 * recovery behaviour without a k6 binary; `default()` itself is covered with
 * `vi.mock` factories for those three built-ins.
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const DEFAULT_BASE_URL = 'http://localhost:3000';

/** Fixed header value used to scope every request to the load-test tenant. */
export const TENANT_ID = 'load-test-tenant';

/** Attester address used by the happy-path payload. */
export const ATTESTER_ADDRESS = '0x1234567890123456789012345678901234567890';

/** `subject` is a 20-byte identifier rendered as 40 lowercase hex characters. */
export const SUBJECT_HEX_CHARS = 40;

/**
 * Number of iterations each VU can generate before its id space overlaps the
 * next VU's. With the configured 25 s run and 20 VUs this is never approached.
 */
export const ITERATIONS_PER_VU = 1_000_000;

/**
 * Statuses the happy path may legitimately answer with under concurrent load.
 * 201 = created, 409 = the deterministic subject already exists (a previous VU
 * or a re-run of the same iteration range), which is expected rather than a
 * failure.
 */
export const HAPPY_PATH_STATUSES = [201, 409];

/** The sad path must be rejected with a validation error, and nothing else. */
export const VALIDATION_ERROR_STATUS = 400;

/** Pause between iterations, in seconds. */
export const ITERATION_PAUSE_SECONDS = 0.1;

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

/**
 * Read a k6 `__ENV` value.
 *
 * `__ENV` is injected by the k6 runtime and does not exist under Node, so it is
 * read guardedly. Outside k6 (unit tests) this resolves to `undefined` and the
 * caller falls back to its default.
 */
export function readEnv(name) {
  return typeof __ENV !== 'undefined' ? __ENV[name] : undefined;
}

export const BASE_URL = readEnv('BASE_URL') || DEFAULT_BASE_URL;

/* -------------------------------------------------------------------------- */
/* Deterministic builders                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalise an id component to a non-negative integer.
 *
 * Non-integer, negative, non-finite and non-numeric inputs become `0`, so the
 * builders below are total rather than partial: they never emit `NaN`, which
 * would serialise as `null` in the request body and be rejected with an
 * unexplained 400 that looks like a validation bug in the API.
 */
function toNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Build the deterministic per-iteration identifier.
 *
 * @param {number} vuId              `exec.vu.idInTest`
 * @param {number} iteration         `exec.vu.iterationInInstance`
 * @returns {number} finite, non-negative id
 */
export function buildUniqueId(vuId, iteration) {
  const vu = toNonNegativeInteger(vuId);
  const iterationCount = toNonNegativeInteger(iteration);
  const id = vu * ITERATIONS_PER_VU + iterationCount;

  // A large-but-representable VU id multiplies out to `Infinity`. Clamping
  // keeps the id finite so `buildSubject` still renders a valid identifier
  // instead of the literal string "Infinity" padded into a subject.
  return Number.isFinite(id) ? id : Number.MAX_SAFE_INTEGER;
}

/**
 * Render an identifier as a valid `0x`-prefixed 20-byte subject.
 *
 * The identifier is rendered as-is: it is *not* re-derived from a VU/iteration
 * pair, so `buildSubject(buildUniqueId(vu, iteration))` is the identity on the
 * generated id and `bondId` and `subject` in a payload always describe the same
 * iteration.
 *
 * The width is pinned in both directions. `padStart` alone only handled values
 * that are too small; a large enough id produced a subject longer than 40 hex
 * characters, which the API rejects — turning the happy path into a 400 and
 * making the load test measure validation failures instead of throughput.
 *
 * @param {number} uniqueId
 * @returns {string} `0x` followed by exactly {@link SUBJECT_HEX_CHARS} hex chars
 */
export function buildSubject(uniqueId) {
  const hex = toNonNegativeInteger(uniqueId).toString(16);
  const bounded = hex.length > SUBJECT_HEX_CHARS
    ? hex.slice(-SUBJECT_HEX_CHARS)
    : hex.padStart(SUBJECT_HEX_CHARS, '0');
  return `0x${bounded}`;
}

/**
 * Happy-path payload: every required field present, so the request is expected
 * to be accepted.
 */
export function buildHappyPathPayload(uniqueId) {
  return {
    bondId: uniqueId,
    attesterAddress: ATTESTER_ADDRESS,
    subject: buildSubject(uniqueId),
    value: 'load_test_value',
    score: 100,
  };
}

/**
 * Sad-path payload: deliberately omits `bondId` and `attesterAddress`, the two
 * required fields, so the request must be rejected with 400.
 */
export function buildSadPathPayload(uniqueId) {
  return {
    subject: buildSubject(uniqueId),
    value: 'invalid_attestation',
  };
}

/** Shared request parameters, including the tenant scoping header. */
export function buildRequestParams() {
  return {
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': TENANT_ID,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Status predicates                                                          */
/* -------------------------------------------------------------------------- */

/** `true` when `status` is an acceptable happy-path outcome. */
export function isExpectedHappyPathStatus(status) {
  return HAPPY_PATH_STATUSES.includes(status);
}

/** `true` only for the validation rejection the sad path must produce. */
export function isExpectedSadPathStatus(status) {
  return status === VALIDATION_ERROR_STATUS;
}

/* -------------------------------------------------------------------------- */
/* Request builders                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build both requests for one iteration.
 *
 * Exported so the URL, body and params that are actually sent can be asserted
 * without a live k6 runtime.
 *
 * @param {number} vuId      defaults to the current VU
 * @param {number} iteration defaults to the current iteration
 */
export function buildIterationRequests(
  vuId = exec.vu.idInTest,
  iteration = exec.vu.iterationInInstance,
) {
  const uniqueId = buildUniqueId(vuId, iteration);
  const url = `${BASE_URL}/api/attestations`;

  return {
    uniqueId,
    happyPath: {
      url,
      body: JSON.stringify(buildHappyPathPayload(uniqueId)),
      params: buildRequestParams(),
    },
    sadPath: {
      url,
      body: JSON.stringify(buildSadPathPayload(uniqueId)),
      params: buildRequestParams(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Iteration                                                                  */
/* -------------------------------------------------------------------------- */

export default function () {
  const { happyPath, sadPath } = buildIterationRequests();

  try {
    const res = http.post(happyPath.url, happyPath.body, happyPath.params);

    check(res, {
      'happy path: is status 201': (r) => isExpectedHappyPathStatus(r.status),
    });

    // Explicit Sad Path: missing bondId and attesterAddress
    const sadRes = http.post(sadPath.url, sadPath.body, sadPath.params);

    check(sadRes, {
      'sad path: is status 400 validation error': (r) => isExpectedSadPathStatus(r.status),
    });
  } finally {
    // Pacing must happen even when a request throws (an unresolvable host, a
    // TLS failure, or k6's own request-abort errors). Without this the VU would
    // immediately re-enter the iteration and hammer a service that is already
    // failing.
    sleep(ITERATION_PAUSE_SECONDS);
  }
}
