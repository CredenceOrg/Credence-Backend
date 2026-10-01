import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* -------------------------------------------------------------------------- */
/* k6 runtime doubles                                                         */
/* -------------------------------------------------------------------------- */
/**
 * `k6`, `k6/http` and `k6/execution` only exist inside the k6 runtime, so the
 * suite substitutes them with `vi.mock` factories. That works for these
 * unresolvable built-ins and means the coverage below needs no k6 binary, no
 * network, and no alias entry in `vitest.config.ts`.
 *
 * `vi.hoisted` is required because `vi.mock` factories are lifted above the
 * imports at compile time, so they cannot close over ordinary module state.
 */
const k6State = vi.hoisted(() => ({
  /** Every `http.post` call, in order: `{ url, body, params }`. */
  posts: [],
  /** Every `check` call: `{ res, results: [{ name, passed }] }`. */
  checks: [],
  /** Seconds passed to `sleep`, in order. */
  sleeps: [],
  /** Mutable stand-in for `exec.vu`, read at call time by the script. */
  vu: { idInTest: 1, iterationInInstance: 0 },
  /** Per-test override for how `http.post` behaves. */
  postImpl: null,
  /** Per-test override for how `check` behaves. */
  checkImpl: null,
}));

vi.mock('k6/http', () => ({
  default: {
    post: (url, body, params) => {
      k6State.posts.push({ url, body, params });
      return k6State.postImpl(url, body, params);
    },
  },
}));

vi.mock('k6', () => ({
  // Mirrors the real `check`: evaluate every predicate, report each result, and
  // answer `true` only when all of them held. Evaluating the predicates (rather
  // than returning a constant) is what lets the assertions below cover the
  // status logic that actually ships.
  check: (res, specs) => {
    const results = Object.entries(specs).map(([name, predicate]) => ({
      name,
      passed: Boolean(predicate(res)),
    }));
    k6State.checks.push({ res, results });
    return k6State.checkImpl ? k6State.checkImpl(results) : results.every((r) => r.passed);
  },
  sleep: (seconds) => {
    k6State.sleeps.push(seconds);
  },
}));

vi.mock('k6/execution', () => ({
  // Resolved through a getter so tests can point `exec.vu` at a different VU
  // and iteration without re-importing the module under test.
  default: {
    get vu() {
      return k6State.vu;
    },
  },
}));

import writePath, {
  ATTESTER_ADDRESS,
  BASE_URL,
  DEFAULT_BASE_URL,
  HAPPY_PATH_STATUSES,
  ITERATION_PAUSE_SECONDS,
  ITERATIONS_PER_VU,
  SUBJECT_HEX_CHARS,
  TENANT_ID,
  VALIDATION_ERROR_STATUS,
  buildHappyPathPayload,
  buildIterationRequests,
  buildRequestParams,
  buildSadPathPayload,
  buildSubject,
  buildUniqueId,
  isExpectedHappyPathStatus,
  isExpectedSadPathStatus,
  options,
  readEnv,
} from './write-path.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A valid 20-byte subject: `0x` followed by exactly 40 lowercase hex chars. */
const SUBJECT_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * Default `http.post` behaviour: behave like the real endpoint. The sad-path
 * body carries the sentinel `invalid_attestation` value and must be rejected,
 * everything else is accepted. This keeps `default()`'s own checks honest.
 */
function defaultPostImpl(_url, body) {
  return { status: String(body).includes('invalid_attestation') ? 400 : 201 };
}

/** Parse the JSON body captured for the n-th `http.post` call of a run. */
function postedBody(index) {
  const call = k6State.posts[index];
  if (!call) throw new Error(`expected http.post call #${index} to have happened`);
  return JSON.parse(call.body);
}

beforeEach(() => {
  k6State.posts = [];
  k6State.checks = [];
  k6State.sleeps = [];
  k6State.vu = { idInTest: 1, iterationInInstance: 0 };
  k6State.postImpl = defaultPostImpl;
  k6State.checkImpl = null;
});

afterEach(() => {
  delete globalThis.__ENV;
});

/* -------------------------------------------------------------------------- */
/* Load profile                                                               */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – load profile', () => {
  it('exports a function as the k6 entry point (`module` export of the issue)', () => {
    expect(typeof writePath).toBe('function');
  });

  it('keeps the documented ramp-up/steady/ramp-down stages', () => {
    expect(options.stages).toEqual([
      { duration: '5s', target: 20 },
      { duration: '15s', target: 20 },
      { duration: '5s', target: 0 },
    ]);
  });

  it('keeps the p(99) latency threshold so regressions still fail the run', () => {
    expect(options.thresholds.http_req_duration).toEqual(['p(99)<1000']);
  });

  it('exposes the statuses and pause used by the iteration contract', () => {
    expect(HAPPY_PATH_STATUSES).toEqual([201, 409]);
    expect(VALIDATION_ERROR_STATUS).toBe(400);
    expect(ITERATION_PAUSE_SECONDS).toBe(0.1);
    expect(SUBJECT_HEX_CHARS).toBe(40);
    expect(ITERATIONS_PER_VU).toBe(1_000_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Environment handling                                                       */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – environment handling', () => {
  it('can be imported outside the k6 runtime, where `__ENV` is undefined', () => {
    // Regression guard: reading `__ENV.BASE_URL` unguarded crashed the module
    // under Node, which made every unit test of the load script impossible.
    expect(readEnv('BASE_URL')).toBeUndefined();
    expect(BASE_URL).toBe(DEFAULT_BASE_URL);
    expect(DEFAULT_BASE_URL).toBe('http://localhost:3000');
  });

  it('reads values from `__ENV` when the k6 runtime provides them', () => {
    globalThis.__ENV = { BASE_URL: 'https://perf.example.test', OTHER: 'ignored' };
    expect(readEnv('BASE_URL')).toBe('https://perf.example.test');
    expect(readEnv('MISSING')).toBeUndefined();
  });

  it('treats an explicitly empty `__ENV` value as unset', () => {
    globalThis.__ENV = { BASE_URL: '' };
    expect(readEnv('BASE_URL') || DEFAULT_BASE_URL).toBe(DEFAULT_BASE_URL);
  });

  it('resolves BASE_URL from `__ENV` at module scope', async () => {
    globalThis.__ENV = { BASE_URL: 'https://staging.example.test' };
    vi.resetModules();
    const mod = await import('./write-path.js');
    expect(mod.BASE_URL).toBe('https://staging.example.test');
  });

  it('falls back to the default when `__ENV` is present but BASE_URL is not', async () => {
    globalThis.__ENV = { UNRELATED: 'x' };
    vi.resetModules();
    const mod = await import('./write-path.js');
    expect(mod.BASE_URL).toBe(mod.DEFAULT_BASE_URL);
  });
});

/* -------------------------------------------------------------------------- */
/* uniqueId boundaries                                                        */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – buildUniqueId boundaries', () => {
  it('is deterministic: the same (VU, iteration) pair always maps to one id', () => {
    expect(buildUniqueId(3, 7)).toBe(buildUniqueId(3, 7));
    expect(buildUniqueId(3, 7)).toBe(3 * ITERATIONS_PER_VU + 7);
  });

  it('does not overlap between adjacent VUs inside the documented id space', () => {
    // The last id VU 1 may generate must stay below the first id of VU 2.
    expect(buildUniqueId(1, ITERATIONS_PER_VU - 1)).toBe(ITERATIONS_PER_VU * 2 - 1);
    expect(buildUniqueId(2, 0)).toBe(ITERATIONS_PER_VU * 2);
    expect(buildUniqueId(1, ITERATIONS_PER_VU - 1)).not.toBe(buildUniqueId(2, 0));
  });

  it('collides exactly at the documented VU boundary and not one step before', () => {
    // Boundary documentation guard: `ITERATIONS_PER_VU` is the exclusive upper
    // bound of each VU's id space, exactly as its docblock claims.
    expect(buildUniqueId(0, ITERATIONS_PER_VU)).toBe(buildUniqueId(1, 0));
    expect(buildUniqueId(0, ITERATIONS_PER_VU - 1)).not.toBe(buildUniqueId(1, 0));
  });

  it('handles the first possible id', () => {
    expect(buildUniqueId(0, 0)).toBe(0);
  });

  it.each([
    ['negative VU id', -1, 5, 5],
    ['negative iteration', 2, -5, 2 * ITERATIONS_PER_VU],
    ['fractional VU id', 1.5, 0, 0],
    ['fractional iteration', 1, 0.5, ITERATIONS_PER_VU],
    ['NaN', Number.NaN, Number.NaN, 0],
    ['Infinity', Number.POSITIVE_INFINITY, 0, 0],
    ['string inputs', '4', '9', 0],
    ['null inputs', null, null, 0],
    ['undefined inputs', undefined, undefined, 0],
  ])('normalises %s to a total, non-NaN id', (_label, vuId, iteration, expected) => {
    const id = buildUniqueId(vuId, iteration);
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(id).toBe(expected);
  });

  it('never returns NaN, which would serialise as `null` and cause an unexplained 400', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, 'abc', {}, []]) {
      expect(Number.isNaN(buildUniqueId(bad, bad))).toBe(false);
    }
  });

  it('stays a finite integer beyond the safe-integer range', () => {
    const id = buildUniqueId(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(id)).toBe(true);
    expect(id).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* subject width boundaries                                                   */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – buildSubject width boundaries', () => {
  it('renders the smallest id as a full-width, all-zero subject', () => {
    const subject = buildSubject(0);
    expect(subject).toBe(`0x${'0'.repeat(SUBJECT_HEX_CHARS)}`);
    expect(subject).toHaveLength(2 + SUBJECT_HEX_CHARS);
    expect(subject).toMatch(SUBJECT_PATTERN);
  });

  it('left-pads ids that are too narrow', () => {
    expect(buildSubject(0x1)).toBe(`0x${'0'.repeat(39)}1`);
    expect(buildSubject(1)).toMatch(SUBJECT_PATTERN);
  });

  it('leaves a subject of exactly 40 hex chars untouched', () => {
    // 16 ** 39 === 2 ** 156, whose hex form is '1' followed by 39 zeros: the
    // widest value that still fits without truncation.
    const exact = 16 ** 39;
    expect(exact.toString(16)).toHaveLength(SUBJECT_HEX_CHARS);

    const subject = buildSubject(exact);
    expect(subject).toBe(`0x${exact.toString(16)}`);
    expect(subject).toMatch(SUBJECT_PATTERN);
  });

  it('clamps ids wider than 40 hex chars instead of producing an invalid subject', () => {
    // Regression guard: `padStart` alone did nothing for over-wide ids, so a
    // large enough VU/iteration product sent a >40-char subject and the API
    // answered 400 — the happy path silently became a validation failure.
    const overWide = 16 ** 40; // 2 ** 160 → '1' followed by 40 zeros
    expect(overWide.toString(16)).toHaveLength(SUBJECT_HEX_CHARS + 1);

    const subject = buildSubject(overWide);
    expect(subject).toHaveLength(2 + SUBJECT_HEX_CHARS);
    expect(subject).toMatch(SUBJECT_PATTERN);
    // The low-order 40 hex chars are kept, so the id is still distinguishable.
    expect(subject).toBe(`0x${overWide.toString(16).slice(-SUBJECT_HEX_CHARS)}`);
  });

  it.each([
    ['max safe integer', Number.MAX_SAFE_INTEGER],
    ['2 ** 160', 2 ** 160],
    ['Number.MAX_VALUE', Number.MAX_VALUE],
    ['exponent-notation value', 1e30],
  ])('always yields a valid 20-byte subject for %s', (_label, uniqueId) => {
    expect(buildSubject(uniqueId)).toMatch(SUBJECT_PATTERN);
  });

  it('is total for invalid inputs', () => {
    for (const bad of [Number.NaN, -1, Infinity, 'nope', null]) {
      expect(buildSubject(bad)).toBe(`0x${'0'.repeat(SUBJECT_HEX_CHARS)}`);
    }
  });

  it('is deterministic', () => {
    expect(buildSubject(123_456)).toBe(buildSubject(123_456));
  });
});

/* -------------------------------------------------------------------------- */
/* determinism and uniqueness of generated identities                         */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – deterministic identities', () => {
  it('keeps the happy path byte-identical across repeated builds', () => {
    expect(JSON.stringify(buildHappyPathPayload(42))).toBe(
      JSON.stringify(buildHappyPathPayload(42)),
    );
  });

  it('keeps subjects unique across a realistic VU/iteration sweep', () => {
    // A collision here would fabricate 409s and make the throughput numbers
    // meaningless, so the whole sample must be distinct.
    const subjects = new Set();
    for (let vu = 1; vu <= 20; vu += 1) {
      for (let iteration = 0; iteration < 50; iteration += 1) {
        subjects.add(buildSubject(buildUniqueId(vu, iteration)));
      }
    }
    expect(subjects.size).toBe(20 * 50);
  });

  it('does not share state between calls (no accidental 409 on the next iteration)', () => {
    const first = buildIterationRequests(4, 0);
    const interleaved = buildIterationRequests(9, 3);
    const second = buildIterationRequests(4, 1);

    expect(first.uniqueId).not.toBe(second.uniqueId);
    expect(JSON.parse(first.happyPath.body).subject).not.toBe(
      JSON.parse(second.happyPath.body).subject,
    );
    expect(JSON.parse(interleaved.happyPath.body).subject).not.toBe(
      JSON.parse(first.happyPath.body).subject,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* payload and request contracts                                              */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – payload contracts', () => {
  it('builds a happy-path payload with every required field', () => {
    const payload = buildHappyPathPayload(7);
    expect(payload).toEqual({
      bondId: 7,
      attesterAddress: ATTESTER_ADDRESS,
      subject: buildSubject(7),
      value: 'load_test_value',
      score: 100,
    });
    expect(Object.keys(payload).sort()).toEqual(
      ['attesterAddress', 'bondId', 'score', 'subject', 'value'].sort(),
    );
    expect(payload.subject).toMatch(SUBJECT_PATTERN);
  });

  it('builds a sad-path payload that omits both required fields', () => {
    const payload = buildSadPathPayload(7);
    expect(payload).not.toHaveProperty('bondId');
    expect(payload).not.toHaveProperty('attesterAddress');
    expect(payload.subject).toMatch(SUBJECT_PATTERN);
    expect(payload.value).toBe('invalid_attestation');
  });

  it('keeps the happy and sad payloads distinct for the same id', () => {
    expect(buildHappyPathPayload(11)).not.toEqual(buildSadPathPayload(11));
  });

  it('scopes every request to the load-test tenant only', () => {
    const params = buildRequestParams();
    expect(params).toEqual({
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': TENANT_ID,
      },
    });
  });

  it('sends no credentials or secrets with the load-test traffic', () => {
    // Guard against someone adding an auth token to the load profile: these
    // headers are unauthenticated by design and must stay that way.
    const headerNames = Object.keys(buildRequestParams().headers);
    expect(headerNames).toEqual(['Content-Type', 'x-tenant-id']);
    expect(headerNames.join(',')).not.toMatch(/authorization|api[-_]?key|secret|token|cookie/i);
  });

  it('does not leak secrets into the request bodies', () => {
    const body = JSON.stringify([
      buildHappyPathPayload(1),
      buildSadPathPayload(1),
    ]);
    expect(body).not.toMatch(/secret|password|private[-_]?key|bearer/i);
  });

  it('targets the attestations endpoint of the resolved BASE_URL', () => {
    const { happyPath, sadPath } = buildIterationRequests(2, 3);
    expect(happyPath.url).toBe(`${BASE_URL}/api/attestations`);
    expect(sadPath.url).toBe(`${BASE_URL}/api/attestations`);
  });

  it('serialises bodies as valid JSON carrying the built payload', () => {
    const { happyPath, sadPath, uniqueId } = buildIterationRequests(2, 3);
    expect(uniqueId).toBe(buildUniqueId(2, 3));
    expect(JSON.parse(happyPath.body)).toEqual(buildHappyPathPayload(uniqueId));
    expect(JSON.parse(sadPath.body)).toEqual(buildSadPathPayload(uniqueId));
  });

  it('defaults to the current VU and iteration when called with no arguments', () => {
    k6State.vu.idInTest = 17;
    k6State.vu.iterationInInstance = 4;

    const { uniqueId, happyPath } = buildIterationRequests();
    expect(uniqueId).toBe(buildUniqueId(17, 4));
    expect(JSON.parse(happyPath.body).bondId).toBe(buildUniqueId(17, 4));
  });
});

/* -------------------------------------------------------------------------- */
/* status predicates                                                          */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – status predicates', () => {
  it('accepts created and duplicate-collision responses on the happy path', () => {
    expect(isExpectedHappyPathStatus(201)).toBe(true);
    expect(isExpectedHappyPathStatus(409)).toBe(true);
  });

  it('rejects every other status on the happy path', () => {
    for (const status of [200, 204, 400, 401, 403, 422, 429, 500, 502, 503, 0, undefined]) {
      expect(isExpectedHappyPathStatus(status)).toBe(false);
    }
  });

  it('accepts only a validation error on the sad path', () => {
    expect(isExpectedSadPathStatus(400)).toBe(true);
    for (const status of [201, 409, 200, 401, 422, 500, 0, undefined]) {
      expect(isExpectedSadPathStatus(status)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* default(): success path                                                    */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – default() success path', () => {
  it('issues the happy request, then the sad request, against the same endpoint', () => {
    writePath();

    expect(k6State.posts).toHaveLength(2);
    expect(k6State.posts[0].url).toBe(`${BASE_URL}/api/attestations`);
    expect(k6State.posts[1].url).toBe(`${BASE_URL}/api/attestations`);
    expect(k6State.posts[0].params).toEqual(buildRequestParams());
    expect(k6State.posts[1].params).toEqual(buildRequestParams());
  });

  it('sends the happy payload first and the invalid payload second', () => {
    k6State.vu = { idInTest: 5, iterationInInstance: 2 };
    writePath();

    const expectedId = buildUniqueId(5, 2);
    expect(postedBody(0)).toEqual(buildHappyPathPayload(expectedId));
    expect(postedBody(1)).toEqual(buildSadPathPayload(expectedId));
  });

  it('records both checks with stable, diagnosable labels', () => {
    writePath();

    expect(k6State.checks).toHaveLength(2);
    expect(k6State.checks[0].results).toEqual([
      { name: 'happy path: is status 201', passed: true },
    ]);
    expect(k6State.checks[1].results).toEqual([
      { name: 'sad path: is status 400 validation error', passed: true },
    ]);
  });

  it('pauses once per iteration using the documented duration', () => {
    writePath();
    expect(k6State.sleeps).toEqual([ITERATION_PAUSE_SECONDS]);
  });

  it('is deterministic across iterations of the same VU', () => {
    k6State.vu = { idInTest: 3, iterationInInstance: 0 };
    writePath();
    k6State.vu = { idInTest: 3, iterationInInstance: 1 };
    writePath();

    expect(k6State.posts[0].body).not.toBe(k6State.posts[2].body);
    expect(k6State.posts[0].url).toBe(k6State.posts[2].url);
    expect(k6State.sleeps).toEqual([ITERATION_PAUSE_SECONDS, ITERATION_PAUSE_SECONDS]);
  });

  it('produces a fresh iteration payload for each of two runs with the same inputs', () => {
    k6State.vu = { idInTest: 8, iterationInInstance: 9 };
    writePath();
    const firstRun = k6State.posts.map((call) => call.body);

    k6State.posts = [];
    writePath();
    const secondRun = k6State.posts.map((call) => call.body);

    expect(secondRun).toEqual(firstRun);
  });
});

/* -------------------------------------------------------------------------- */
/* default(): duplicate / rejection paths                                     */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – duplicate and rejection outcomes', () => {
  it('treats a 409 collision on the happy path as expected, not a failure', () => {
    k6State.postImpl = (_url, body) => ({
      status: String(body).includes('invalid_attestation') ? 400 : 409,
    });
    writePath();

    expect(k6State.checks[0].res.status).toBe(409);
    expect(k6State.checks[0].results[0].passed).toBe(true);
    expect(k6State.checks[1].results[0].passed).toBe(true);
  });

  it('flags a 400 on the happy path as a failed check', () => {
    // The exact symptom of the over-wide-subject bug: the happy path gets
    // validation-rejected. The check must report the failure to k6.
    k6State.postImpl = () => ({ status: 400 });
    writePath();

    expect(k6State.checks[0].results[0].passed).toBe(false);
    expect(k6State.checks[1].results[0].passed).toBe(true);
  });

  it('flags a non-400 rejection on the sad path as a failed check', () => {
    k6State.postImpl = (_url, body) => ({
      status: String(body).includes('invalid_attestation') ? 401 : 201,
    });
    writePath();

    expect(k6State.checks[1].results[0].passed).toBe(false);
  });

  it('does not throw when the service answers with a server error', () => {
    k6State.postImpl = () => ({ status: 503 });
    expect(() => writePath()).not.toThrow();
    expect(k6State.checks.every((c) => c.results.every((r) => !r.passed))).toBe(true);
    expect(k6State.sleeps).toEqual([ITERATION_PAUSE_SECONDS]);
  });
});

/* -------------------------------------------------------------------------- */
/* default(): failure and recovery paths                                      */
/* -------------------------------------------------------------------------- */

describe('perf/k6/write-path.js – failure recovery', () => {
  it('still paces the iteration when the happy request throws', () => {
    // Recovery contract: a throwing request (unresolvable host, TLS failure,
    // k6 abort) must not skip the pause, or the VU re-enters immediately and
    // turns the generator into an unpaced hot loop against a failing service.
    k6State.postImpl = () => {
      throw new Error('dial tcp: connection refused');
    };

    expect(() => writePath()).toThrow('connection refused');
    expect(k6State.posts).toHaveLength(1);
    expect(k6State.sleeps).toEqual([ITERATION_PAUSE_SECONDS]);
  });

  it('still paces the iteration when the sad request throws', () => {
    k6State.postImpl = (_url, body) => {
      if (String(body).includes('invalid_attestation')) throw new Error('request aborted');
      return { status: 201 };
    };

    expect(() => writePath()).toThrow('request aborted');
    expect(k6State.posts).toHaveLength(2);
    expect(k6State.sleeps).toEqual([ITERATION_PAUSE_SECONDS]);
  });

  it('paces every iteration of a sustained outage (no unpaced retry loop)', () => {
    k6State.postImpl = () => {
      throw new Error('network unreachable');
    };

    const iterations = 5;
    for (let i = 0; i < iterations; i += 1) {
      k6State.vu = { idInTest: 1, iterationInInstance: i };
      expect(() => writePath()).toThrow('network unreachable');
    }

    expect(k6State.sleeps).toEqual(Array(iterations).fill(ITERATION_PAUSE_SECONDS));
    expect(k6State.posts).toHaveLength(iterations);
  });

  it('recovers cleanly once the service is reachable again', () => {
    k6State.postImpl = () => {
      throw new Error('connection reset');
    };
    k6State.vu = { idInTest: 2, iterationInInstance: 0 };
    expect(() => writePath()).toThrow('connection reset');

    k6State.posts = [];
    k6State.postImpl = defaultPostImpl;
    k6State.vu = { idInTest: 2, iterationInInstance: 1 };
    expect(() => writePath()).not.toThrow();

    expect(k6State.checks).toHaveLength(2);
    expect(k6State.checks[0].results[0].passed).toBe(true);
    expect(k6State.checks[1].results[0].passed).toBe(true);
    expect(k6State.sleeps).toEqual([ITERATION_PAUSE_SECONDS, ITERATION_PAUSE_SECONDS]);
  });

  it('does not record a check when the happy request throws before responding', () => {
    k6State.postImpl = () => {
      throw new Error('connection refused');
    };

    expect(() => writePath()).toThrow();
    expect(k6State.checks).toHaveLength(0);
  });

  it('propagates the original error untouched, so k6 reports the real cause', () => {
    const original = new Error('x509: certificate signed by unknown authority');
    k6State.postImpl = () => {
      throw original;
    };

    try {
      writePath();
      throw new Error('expected writePath() to throw');
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  it('paces even when the check itself throws, because the pause is in `finally`', () => {
    // The pause is not conditional on the check succeeding: a k6-side failure
    // must not be able to bypass the pacing guarantee either.
    k6State.postImpl = () => ({ status: 201 });
    k6State.checkImpl = () => {
      throw new Error('check blew up');
    };

    expect(() => writePath()).toThrow('check blew up');
    expect(k6State.sleeps).toEqual([ITERATION_PAUSE_SECONDS]);
  });
});
