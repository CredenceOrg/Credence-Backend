/**
 * Boundary and recovery test coverage for the security gate.
 *
 * `scripts/security-gate.ts` is a CI security control: it reads an `npm audit`
 * or Trivy report and exits non-zero when any finding meets or exceeds a
 * severity threshold that is not allowlisted. A bug here does not degrade
 * gracefully — it silently stops blocking vulnerable code from shipping.
 *
 * This suite validates deterministic behaviour under:
 * - Valid, invalid, duplicate, and boundary-case inputs
 * - Policy/authorization invariants (threshold, allowlist, severity ranking)
 * - Malformed report recovery and the CLI exit-code contract
 * - Concurrency and retry safety of the stdin reader
 *
 * ---------------------------------------------------------------------------
 * Import safety
 * ---------------------------------------------------------------------------
 * The module ends with `if (process.env.NODE_ENV !== 'test') main()...`, and
 * `main()` calls `process.exit()`. Vitest only *defaults* `NODE_ENV` to `test`
 * when it is unset — if the ambient environment already exports
 * `NODE_ENV=production`, a *static* import starts `main()` and hijacks the test
 * runner. This file therefore pins `NODE_ENV` and then loads the module with a
 * top-level `await import()`, so `main()` provably cannot run regardless of the
 * ambient environment. `import type` is erased at compile time and does not
 * trigger a runtime load.
 *
 * ---------------------------------------------------------------------------
 * Invariants locked in by this suite
 * ---------------------------------------------------------------------------
 * P1. Threshold comparison is inclusive: a finding whose severity rank equals
 *     the threshold rank is a violation. Off-by-one here silently narrows the
 *     gate by one severity level.
 * P2. An unrecognised `threshold` falls back to rank 3 (`high`); an
 *     unrecognised `severity` falls back to rank 1 (`low`).
 * P3. Allowlist matching is exact and case-sensitive, for both package names
 *     and CVE/advisory ids. No substring or prefix matching.
 * P4. An issue id is one string that may pack several ids joined by `', '`.
 *     Allowlisting any one of them suppresses the whole issue.
 * P5. `evaluateGate` does not mutate its inputs, preserves input order in
 *     `violatingIssues`, and counts duplicate issues separately.
 * P6. Repeated `--ignore-pkg` / `--ignore-cve` flags *replace* rather than
 *     accumulate. Repeated `--file` / `--threshold` / `--format`: last wins.
 * P7. Empty and whitespace-only report content yields zero findings rather than
 *     throwing.
 * P8. Every operational failure path exits 1 with a message naming the cause:
 *     missing file, blank stdin, unparseable JSON, undetectable format, and a
 *     policy violation. Note this is *not* the same as "exits 1 whenever the
 *     report contains a serious finding" — see S1 through S4, which are cases
 *     where the gate reports success it should not.
 *
 * ---------------------------------------------------------------------------
 * Known security limitations asserted as current behaviour (NOT fixed here)
 * ---------------------------------------------------------------------------
 * This change set is test coverage only, per the issue's scope. The following
 * fail-open paths are real and are pinned by tests so they cannot change
 * silently, but each should become a follow-up hardening change.
 *
 * S1. **An unrecognised `--format` disables the gate entirely.** `main()` only
 *     dispatches on the literal strings `npm-audit` and `trivy`. Any other value
 *     leaves `issues` as `[]`, so the gate prints "PASSED: No policy-violating
 *     vulnerabilities found" and exits 0 — even for a report full of criticals.
 *     Both `--format=bogus` and `--format=` (empty) do this. A one-character
 *     typo in a CI workflow silently turns the security gate into a no-op that
 *     still reports success.
 * S2. **Cross-format mismatch does the same.** Parsing an `npm audit` report
 *     with `--format=trivy` (or vice versa) finds nothing in the foreign shape
 *     and reports PASSED.
 * S3. **An unrecognised severity is treated as `low`.** `SEVERITY_RANKS[sev] ?? 1`
 *     means a scanner emitting a new or misspelled severity (`severe`,
 *     `important`) ranks 1. At `--threshold medium` (rank 2) such a finding is
 *     *not* a violation, so a genuinely serious advisory passes the gate.
 * S4. **An empty report *file* is indistinguishable from "clean".** Once
 *     `--file` is supplied, main()'s "no input" guard is skipped, so a
 *     truncated or mis-generated report reads as zero findings and exits 0 —
 *     provided `--format` is explicit. Blank *stdin* is caught by that guard
 *     and exits 1, and under `--format=auto` empty content fails
 *     auto-detection. Only the file + explicit-format combination fails open.
 * S5. `readStdin()` registers no `error` listener and never rejects, so a stdin
 *     read error leaves the returned promise pending forever — the job hangs
 *     rather than failing.
 * S6. `readStdin()` called after stdin has already ended never resolves.
 * S7. `parseNpmAudit`/`parseTrivy` throw a raw `TypeError` for a `null` JSON
 *     document, a non-string severity, a `null` `via` array entry, or a `null`
 *     Trivy result/vulnerability entry. `main()` catches these and exits 1, so
 *     it is fail-closed, but the diagnostic is a type error rather than a
 *     report-format message, and it aborts the whole report rather than skipping
 *     the bad entry.
 *
 * Related: Issue #1329
 */

process.env.NODE_ENV = 'test'

import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GateConfig, SecurityIssue } from './security-gate'

// Top-level await load: guarantees the `NODE_ENV` assignment above is applied
// before the module is evaluated, so the `main()` auto-run guard is satisfied.
const gate = await import('./security-gate')

const { SEVERITY_RANKS, parseNpmAudit, parseTrivy, evaluateGate, parseArgs, readStdin } = gate

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = process.cwd()
const GATE_PATH = path.join(ROOT, 'scripts', 'security-gate.ts')

/** GateConfig using the gate's own default threshold. */
function config(overrides: Partial<GateConfig> = {}): GateConfig {
  return { threshold: 'high', ignorePkgs: [], ignoreCves: [], ...overrides }
}

/** Build an npm-audit shaped report from a vulnerability map. */
function npmReport(vulnerabilities: Record<string, unknown>): string {
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities })
}

/** Build a Trivy shaped report from result objects. */
function trivyReport(results: unknown[]): string {
  return JSON.stringify({ SchemaVersion: 2, Results: results })
}

/** Cast helper for deliberately malformed inputs. */
function malformed(value: unknown): SecurityIssue {
  return value as SecurityIssue
}

/** Every severity/rank pair the gate understands. */
const SEVERITIES: Array<[string, number]> = [
  ['info', 0],
  ['low', 1],
  ['medium', 2],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'security-gate-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Write a fixture into the temp dir and return its absolute path. */
function fixture(name: string, contents: string): string {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, contents, 'utf8')
  return p
}

interface GateRun {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Run the gate as a real subprocess so exit codes and the console contract are
 * covered end to end. `NODE_ENV` is forced to a non-test value so the module's
 * `main()` auto-run guard actually fires.
 */
function runGate(args: string[], stdinInput?: string, timeoutMs = 30_000): Promise<GateRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', GATE_PATH, ...args], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`security-gate subprocess timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(stdinInput)
  })
}

/** A report whose single critical finding always fails a high+ gate. */
const CRITICAL_NPM = npmReport({
  lodash: {
    name: 'lodash',
    severity: 'critical',
    via: [{ source: 1096727, name: 'lodash' }],
    fixAvailable: '4.17.21',
  },
})

/** A valid report with no findings at all. */
const CLEAN_NPM = npmReport({
  'left-pad': { name: 'left-pad', severity: 'low', via: ['CVE-1'] },
})

/** A valid Trivy report with one critical finding. */
const CRITICAL_TRIVY = trivyReport([
  {
    Target: 'package-lock.json',
    Vulnerabilities: [
      {
        VulnerabilityID: 'CVE-2023-45133',
        PkgName: 'axios',
        Severity: 'CRITICAL',
        Title: 'SSRF in axios',
        FixedVersion: '0.21.2',
      },
    ],
  },
])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('security-gate - Boundary and Recovery Tests', () => {
  // -------------------------------------------------------------------------
  describe('Module Load Safety', () => {
    it('exports the documented public surface', () => {
      expect(typeof gate.parseNpmAudit).toBe('function')
      expect(typeof gate.parseTrivy).toBe('function')
      expect(typeof gate.evaluateGate).toBe('function')
      expect(typeof gate.parseArgs).toBe('function')
      expect(typeof gate.readStdin).toBe('function')
      expect(typeof gate.SEVERITY_RANKS).toBe('object')
    })

    it('pins NODE_ENV to test so main() cannot hijack the runner', () => {
      // Reaching this assertion at all proves main() did not run and exit.
      expect(process.env.NODE_ENV).toBe('test')
    })

    it('ranks severity monotonically and maps moderate onto medium', () => {
      expect(SEVERITY_RANKS.info).toBe(0)
      expect(SEVERITY_RANKS.low).toBe(1)
      expect(SEVERITY_RANKS.medium).toBe(2)
      expect(SEVERITY_RANKS.moderate).toBe(SEVERITY_RANKS.medium)
      expect(SEVERITY_RANKS.high).toBe(3)
      expect(SEVERITY_RANKS.critical).toBe(4)
    })
  })

  // -------------------------------------------------------------------------
  describe('parseNpmAudit - Boundary Cases', () => {
    // -----------------------------------------------------------------------
    describe('Empty and Degenerate Content (P7)', () => {
      it.each([
        ['empty string', ''],
        ['spaces', '   '],
        ['tabs and newlines', '\t\n  \n'],
      ])('returns no findings for %s without throwing', (_label, content) => {
        expect(parseNpmAudit(content)).toEqual([])
      })

      it('returns no findings when vulnerabilities is absent', () => {
        expect(parseNpmAudit(JSON.stringify({ auditReportVersion: 2 }))).toEqual([])
      })

      it.each([
        ['null', null],
        ['false', false],
        ['zero', 0],
        ['an empty string', ''],
      ])('returns no findings when vulnerabilities is %s', (_label, value) => {
        expect(parseNpmAudit(JSON.stringify({ vulnerabilities: value }))).toEqual([])
      })

      it('returns no findings for an empty vulnerabilities object', () => {
        expect(parseNpmAudit(npmReport({}))).toEqual([])
      })

      it('returns no findings when vulnerabilities is an empty array', () => {
        expect(parseNpmAudit(JSON.stringify({ vulnerabilities: [] }))).toEqual([])
      })
    })

    // -----------------------------------------------------------------------
    describe('Malformed Report Recovery', () => {
      it('throws a SyntaxError on malformed JSON', () => {
        expect(() => parseNpmAudit('{not json')).toThrow(SyntaxError)
      })

      it('throws on a truncated JSON document', () => {
        expect(() => parseNpmAudit('{"vulnerabilities": {')).toThrow(SyntaxError)
      })

      it('returns no findings for bare JSON scalars rather than throwing', () => {
        // JSON.parse accepts scalars, then property access on a primitive
        // yields undefined, so the vulnerabilities guard short-circuits.
        expect(parseNpmAudit('42')).toEqual([])
        expect(parseNpmAudit('"a string"')).toEqual([])
        expect(parseNpmAudit('true')).toEqual([])
        expect(parseNpmAudit('false')).toEqual([])
      })

      it('throws a TypeError for a null document — the guard dereferences it (S7)', () => {
        // `null` is the one JSON scalar that breaks: `report.vulnerabilities`
        // is a property read on null. So is `undefined`, if it were reachable.
        expect(() => parseNpmAudit('null')).toThrow(TypeError)
        expect(() => parseTrivy('null')).toThrow(TypeError)
      })

      it('finds nothing when handed a Trivy report — the shape behind S2', () => {
        expect(parseNpmAudit(CRITICAL_TRIVY)).toEqual([])
      })

      it('is a pure function of its input', () => {
        expect(parseNpmAudit(CRITICAL_NPM)).toEqual(parseNpmAudit(CRITICAL_NPM))
      })
    })

    // -----------------------------------------------------------------------
    describe('Severity Normalisation (P2)', () => {
      it('lower-cases an upper-case severity', () => {
        const [issue] = parseNpmAudit(npmReport({ p: { name: 'p', severity: 'CRITICAL', via: ['a'] } }))

        expect(issue.severity).toBe('critical')
      })

      it.each([
        ['absent', {}],
        ['an empty string', { severity: '' }],
      ])('defaults a %s severity to low', (_label, extra) => {
        const [issue] = parseNpmAudit(npmReport({ p: { name: 'p', via: ['a'], ...extra } }))

        expect(issue.severity).toBe('low')
      })

      it('preserves an unrecognised severity verbatim in lower case', () => {
        // The parser is faithful; it is evaluateGate that mis-ranks unknown
        // severities. See S3.
        const [issue] = parseNpmAudit(npmReport({ p: { name: 'p', severity: 'SEVERE', via: ['a'] } }))

        expect(issue.severity).toBe('severe')
      })

      it('throws a TypeError for a non-string severity (S7)', () => {
        expect(() => parseNpmAudit(npmReport({ p: { name: 'p', severity: 5, via: ['a'] } }))).toThrow(
          TypeError,
        )
      })
    })

    // -----------------------------------------------------------------------
    describe('Advisory ID Extraction', () => {
      it('joins both source and advisory name from a via object', () => {
        const [issue] = parseNpmAudit(
          npmReport({ p: { name: 'p', severity: 'high', via: [{ source: 1096727, name: 'p' }] } }),
        )

        expect(issue.id).toBe('1096727, Advisory:p')
      })

      it('uses only the numeric source when the via object has no name', () => {
        const [issue] = parseNpmAudit(
          npmReport({ p: { name: 'p', severity: 'high', via: [{ source: 1096727 }] } }),
        )

        expect(issue.id).toBe('1096727')
      })

      it('uses the advisory name when the via object has no source', () => {
        const [issue] = parseNpmAudit(
          npmReport({ p: { name: 'p', severity: 'high', via: [{ name: 'p' }] } }),
        )

        expect(issue.id).toBe('Advisory:p')
      })

      it('joins multiple via objects in order', () => {
        const [issue] = parseNpmAudit(
          npmReport({ p: { name: 'p', severity: 'high', via: [{ source: 1, name: 'a' }, { source: 2 }] } }),
        )

        expect(issue.id).toBe('1, Advisory:a, 2')
      })

      it('stringifies numeric via array entries', () => {
        const [issue] = parseNpmAudit(npmReport({ p: { name: 'p', severity: 'high', via: [1, 2] } }))

        expect(issue.id).toBe('1, 2')
      })

      it('skips falsy via array entries', () => {
        // Note: `null` is deliberately absent. `typeof null === 'object'`, so
        // null falls into the object branch and dereferences item.source.
        const [issue] = parseNpmAudit(
          npmReport({ p: { name: 'p', severity: 'high', via: [0, '', 'kept'] } }),
        )

        expect(issue.id).toBe('kept')
      })

      it('throws a TypeError for a null via array entry (S7)', () => {
        // `typeof null === 'object'` sends null into the object branch, where
        // `item.source` throws. The `else if (item)` guard below never applies.
        expect(() =>
          parseNpmAudit(npmReport({ p: { name: 'p', severity: 'high', via: [null, 'kept'] } })),
        ).toThrow(TypeError)
      })

      it('falls back to a package-derived advisory when every via entry is falsy', () => {
        const [issue] = parseNpmAudit(npmReport({ p: { name: 'p', severity: 'high', via: [0, ''] } }))

        expect(issue.id).toBe('Advisory:p')
      })

      it.each([
        ['an empty array', []],
        ['a single empty object', [{ dependency: 'p' }]],
        ['an object without a source', { name: 'p' }],
        ['a zero', 0],
        ['an empty string', ''],
        ['false', false],
        ['null', null],
      ])('falls back to Advisory:<pkg> when via is %s', (_label, via) => {
        const [issue] = parseNpmAudit(npmReport({ p: { name: 'p', severity: 'high', via } }))

        expect(issue.id).toBe('Advisory:p')
      })

      it('reads a single non-array via object source', () => {
        const [issue] = parseNpmAudit(
          npmReport({ p: { name: 'p', severity: 'high', via: { source: 'GHSA-abc' } } }),
        )

        expect(issue.id).toBe('GHSA-abc')
      })

      it('stringifies a scalar via value', () => {
        const [issue] = parseNpmAudit(npmReport({ p: { name: 'p', severity: 'high', via: 'GHSA-x' } }))

        expect(issue.id).toBe('GHSA-x')
      })

      it('falls back when via is absent', () => {
        const [issue] = parseNpmAudit(npmReport({ p: { name: 'p', severity: 'high' } }))

        expect(issue.id).toBe('Advisory:p')
      })
    })

    // -----------------------------------------------------------------------
    describe('Fix Availability and Title', () => {
      it('uses a string fixAvailable verbatim', () => {
        const [issue] = parseNpmAudit(
          npmReport({ p: { name: 'p', severity: 'high', via: ['a'], fixAvailable: '4.17.21' } }),
        )

        expect(issue.fixedVersion).toBe('4.17.21')
      })

      it.each([
        ['true', true, 'Available'],
        ['a number', 123, 'Available'],
        ['an object', { version: '1.0.0' }, 'Available'],
        ['false', false, 'N/A'],
        ['null', null, 'N/A'],
        ['absent', undefined, 'N/A'],
      ])('maps fixAvailable %s to %s', (_label, fixAvailable, expected) => {
        const [issue] = parseNpmAudit(
          npmReport({ p: { name: 'p', severity: 'high', via: ['a'], fixAvailable } }),
        )

        expect(issue.fixedVersion).toBe(expected)
      })

      it('falls back to the package name when name is absent', () => {
        const [issue] = parseNpmAudit(npmReport({ 'the-pkg': { severity: 'high', via: ['a'] } }))

        expect(issue.title).toBe('the-pkg')
      })
    })

    // -----------------------------------------------------------------------
    describe('Collection Boundaries', () => {
      it('preserves report key order', () => {
        const issues = parseNpmAudit(
          npmReport({ c: { severity: 'low' }, a: { severity: 'low' }, b: { severity: 'low' } }),
        )

        expect(issues.map((i) => i.packageName)).toEqual(['c', 'a', 'b'])
      })

      it('handles a large vulnerability set', () => {
        const vulns: Record<string, unknown> = {}
        for (let i = 0; i < 2000; i++) {
          vulns[`pkg-${i}`] = { name: `pkg-${i}`, severity: 'low', via: [`CVE-${i}`] }
        }

        const issues = parseNpmAudit(npmReport(vulns))

        expect(issues).toHaveLength(2000)
        expect(issues[1999].id).toBe('CVE-1999')
      })

      it('treats a __proto__ package key as an ordinary finding without polluting', () => {
        // JSON.parse defines __proto__ as an own property, so Object.entries
        // yields it. Nothing is assigned through it, so there is no pollution.
        const issues = parseNpmAudit(
          '{"vulnerabilities":{"__proto__":{"severity":"high","via":["a"]}}}',
        )

        expect(issues).toHaveLength(1)
        expect(issues[0].packageName).toBe('__proto__')
        expect(({} as Record<string, unknown>).severity).toBeUndefined()
        expect((Object.prototype as unknown as Record<string, unknown>).severity).toBeUndefined()
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('parseTrivy - Boundary Cases', () => {
    // -----------------------------------------------------------------------
    describe('Empty and Degenerate Content (P7)', () => {
      it.each([
        ['an empty string', ''],
        ['whitespace', '  \n\t '],
      ])('returns no findings for %s', (_label, content) => {
        expect(parseTrivy(content)).toEqual([])
      })

      it.each([
        ['absent', {}],
        ['null', { Results: null }],
        ['an empty array', { Results: [] }],
        ['a string', { Results: 'nope' }],
        ['a number', { Results: 7 }],
        ['an object', { Results: {} }],
      ])('returns no findings when Results is %s', (_label, payload) => {
        expect(parseTrivy(JSON.stringify(payload))).toEqual([])
      })

      it('throws a SyntaxError on malformed JSON', () => {
        expect(() => parseTrivy('{nope')).toThrow(SyntaxError)
      })

      it('finds nothing when handed an npm-audit report — the shape behind S2', () => {
        expect(parseTrivy(CRITICAL_NPM)).toEqual([])
      })

      it('is a pure function of its input', () => {
        expect(parseTrivy(CRITICAL_TRIVY)).toEqual(parseTrivy(CRITICAL_TRIVY))
      })
    })

    // -----------------------------------------------------------------------
    describe('Per-Vulnerability Defaults', () => {
      const single = (vuln: unknown) => parseTrivy(trivyReport([{ Vulnerabilities: [vuln] }]))

      it('defaults a missing package name to unknown', () => {
        expect(single({ VulnerabilityID: 'CVE-1', Severity: 'HIGH' })[0].packageName).toBe('unknown')
      })

      it.each([
        ['absent', {}],
        ['an empty string', { Severity: '' }],
      ])('defaults a %s severity to low', (_label, extra) => {
        expect(single({ PkgName: 'p', VulnerabilityID: 'CVE-1', ...extra })[0].severity).toBe('low')
      })

      it('lower-cases an upper-case severity', () => {
        expect(single({ PkgName: 'p', Severity: 'HIGH' })[0].severity).toBe('high')
      })

      it('preserves an unrecognised severity verbatim in lower case', () => {
        expect(single({ PkgName: 'p', Severity: 'UNKNOWN' })[0].severity).toBe('unknown')
      })

      it('defaults a missing vulnerability id to N/A', () => {
        expect(single({ PkgName: 'p', Severity: 'HIGH' })[0].id).toBe('N/A')
      })

      it('prefers Title over Description for the title', () => {
        expect(
          single({ PkgName: 'p', Title: 'A title', Description: 'A description' })[0].title,
        ).toBe('A title')
      })

      it('falls back to Description when Title is absent', () => {
        expect(single({ PkgName: 'p', Description: 'A description' })[0].title).toBe('A description')
      })

      it('falls back to N/A when neither Title nor Description is present', () => {
        expect(single({ PkgName: 'p' })[0].title).toBe('N/A')
      })

      it.each([
        ['absent', {}],
        ['an empty string', { FixedVersion: '' }],
        ['null', { FixedVersion: null }],
      ])('defaults a %s fixed version to N/A', (_label, extra) => {
        expect(single({ PkgName: 'p', ...extra })[0].fixedVersion).toBe('N/A')
      })

      it('keeps an explicit fixed version', () => {
        expect(single({ PkgName: 'p', FixedVersion: '1.2.3' })[0].fixedVersion).toBe('1.2.3')
      })
    })

    // -----------------------------------------------------------------------
    describe('Result and Collection Boundaries', () => {
      it.each([
        ['absent', {}],
        ['null', { Vulnerabilities: null }],
        ['an object', { Vulnerabilities: {} }],
        ['a string', { Vulnerabilities: 'nope' }],
      ])('skips a result whose Vulnerabilities is %s', (_label, result) => {
        expect(parseTrivy(trivyReport([result]))).toEqual([])
      })

      it('throws a TypeError for a null result entry (S7)', () => {
        expect(() => parseTrivy(trivyReport([null]))).toThrow(TypeError)
      })

      it('throws a TypeError for a null vulnerability entry (S7)', () => {
        expect(() => parseTrivy(trivyReport([{ Vulnerabilities: [null] }]))).toThrow(TypeError)
      })

      it('aggregates vulnerabilities across multiple results in order', () => {
        const issues = parseTrivy(
          trivyReport([
            { Vulnerabilities: [{ PkgName: 'a', Severity: 'HIGH' }] },
            { Vulnerabilities: [] },
            { Vulnerabilities: [{ PkgName: 'b', Severity: 'LOW' }] },
          ]),
        )

        expect(issues.map((i) => i.packageName)).toEqual(['a', 'b'])
      })

      it('keeps duplicate findings rather than deduplicating', () => {
        const issues = parseTrivy(
          trivyReport([
            { Vulnerabilities: [{ PkgName: 'a', Severity: 'HIGH' }] },
            { Vulnerabilities: [{ PkgName: 'a', Severity: 'HIGH' }] },
          ]),
        )

        expect(issues).toHaveLength(2)
      })

      it('handles a large result set', () => {
        const vulns = Array.from({ length: 2000 }, (_, i) => ({
          PkgName: `pkg-${i}`,
          VulnerabilityID: `CVE-${i}`,
          Severity: 'LOW',
        }))

        expect(parseTrivy(trivyReport([{ Vulnerabilities: vulns }]))).toHaveLength(2000)
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('evaluateGate - Policy and Authorization Invariants', () => {
    // -----------------------------------------------------------------------
    describe('Threshold Matrix (P1)', () => {
      it.each(SEVERITIES)('fails a %s finding at the %s threshold (inclusive)', (sev) => {
        const result = evaluateGate(
          [{ packageName: 'p', severity: sev, id: 'CVE-1' }],
          config({ threshold: sev as GateConfig['threshold'] }),
        )

        expect(result.violatingIssues).toHaveLength(1)
        expect(result.passed).toBe(false)
      })

      it.each([
        ['info', 'low'],
        ['low', 'medium'],
        ['low', 'high'],
        ['medium', 'high'],
        ['moderate', 'high'],
        ['high', 'critical'],
      ] as Array<[string, GateConfig['threshold']]>)(
        'passes a %s finding at the %s threshold',
        (sev, threshold) => {
          const result = evaluateGate(
            [{ packageName: 'p', severity: sev, id: 'CVE-1' }],
            config({ threshold }),
          )

          expect(result.passed).toBe(true)
          expect(result.violatingIssues).toEqual([])
        },
      )

      it('treats moderate and medium as the same rank', () => {
        // The gate echoes the input issues verbatim, so the two results differ
        // in the `severity` string. Only the *decision* must be identical.
        const moderate = evaluateGate(
          [{ packageName: 'p', severity: 'moderate', id: 'CVE-1' }],
          config({ threshold: 'medium' }),
        )
        const medium = evaluateGate(
          [{ packageName: 'p', severity: 'medium', id: 'CVE-1' }],
          config({ threshold: 'medium' }),
        )

        expect(moderate.passed).toBe(medium.passed)
        expect(moderate.violatingIssues.map((i) => i.packageName)).toEqual(
          medium.violatingIssues.map((i) => i.packageName),
        )
        expect(moderate.violatingIssues).toHaveLength(1)
      })

      it('never lets an info finding violate a real threshold', () => {
        for (const threshold of ['low', 'medium', 'moderate', 'high', 'critical'] as const) {
          const result = evaluateGate(
            [{ packageName: 'p', severity: 'info', id: 'CVE-1' }],
            config({ threshold }),
          )

          expect(result.violatingIssues, `info @ ${threshold}`).toEqual([])
        }
      })

      it('ranks severity case-insensitively', () => {
        const result = evaluateGate(
          [{ packageName: 'p', severity: 'CRITICAL', id: 'CVE-1' }],
          config({ threshold: 'high' }),
        )

        expect(result.violatingIssues).toHaveLength(1)
      })
    })

    // -----------------------------------------------------------------------
    describe('Unrecognised Configuration (P2)', () => {
      it.each([
        ['an unknown word', 'bogus'],
        ['an empty string', ''],
        ['a numeric string', '2'],
      ])('falls back to the high threshold when threshold is %s', (_label, threshold) => {
        const result = evaluateGate(
          [{ packageName: 'p', severity: 'critical', id: 'CVE-1' }],
          config({ threshold: threshold as GateConfig['threshold'] }),
        )

        // Rank 3 (high): the critical still violates, proving the fallback
        // did not degrade to a permissive rank.
        expect(result.violatingIssues).toHaveLength(1)
      })

      it('resolves the fallback precisely — only high and above violate', () => {
        const result = evaluateGate(
          [
            { packageName: 'medium-pkg', severity: 'medium', id: 'CVE-1' },
            { packageName: 'high-pkg', severity: 'high', id: 'CVE-2' },
          ],
          config({ threshold: '' }),
        )

        expect(result.violatingIssues.map((i) => i.packageName)).toEqual(['high-pkg'])
      })

      it('treats an "info" threshold as rank 0, so every finding violates', () => {
        // `info` exists in SEVERITY_RANKS but is not in the threshold union, so
        // this is reachable only by misuse or an unvalidated CLI value.
        const result = evaluateGate(
          [{ packageName: 'p', severity: 'info', id: 'CVE-1' }],
          config({ threshold: 'info' as GateConfig['threshold'] }),
        )

        expect(result.violatingIssues).toHaveLength(1)
      })
    })

    // -----------------------------------------------------------------------
    describe('Unrecognised Severity - FAIL-OPEN (S3)', () => {
      it.each([
        ['severe', 'moderate'],
        ['unknown', 'high'],
        ['important', 'medium'],
        ['a typo of high', 'high'],
      ])(
        'ranks an unrecognised severity %s as low, letting it pass the %s threshold',
        (sev, threshold) => {
          const result = evaluateGate(
            [{ packageName: 'p', severity: sev, id: 'CVE-1' }],
            config({ threshold }),
          )

          // Documented limitation S3: a new or misspelled severity from a
          // scanner ranks 1 and cannot fail a medium-or-higher gate.
          expect(result.passed).toBe(true)
          expect(result.violatingIssues).toEqual([])
        },
      )

      it('only fails an unrecognised severity at the low threshold', () => {
        const result = evaluateGate(
          [{ packageName: 'p', severity: 'severe', id: 'CVE-1' }],
          config({ threshold: 'low' }),
        )

        expect(result.violatingIssues).toHaveLength(1)
      })
    })

    // -----------------------------------------------------------------------
    describe('Package Allowlist (P3)', () => {
      const issues: SecurityIssue[] = [
        { packageName: 'lodash', severity: 'critical', id: 'CVE-1' },
      ]

      it('suppresses an exactly matching package', () => {
        expect(evaluateGate(issues, config({ ignorePkgs: ['lodash'] })).passed).toBe(true)
      })

      it('is case-sensitive', () => {
        expect(evaluateGate(issues, config({ ignorePkgs: ['LODASH'] })).violatingIssues).toHaveLength(1)
      })

      it.each([['loda'], ['lo'], ['lodash-merge'], [' lodash']])(
        'does not match the prefix or substring %j',
        (partial) => {
          expect(evaluateGate(issues, config({ ignorePkgs: [partial] })).violatingIssues).toHaveLength(1)
        },
      )

      it('requires a full match for a scoped package name', () => {
        const scoped: SecurityIssue[] = [
          { packageName: '@scope/pkg', severity: 'critical', id: 'CVE-1' },
        ]

        expect(evaluateGate(scoped, config({ ignorePkgs: ['pkg'] })).violatingIssues).toHaveLength(1)
        expect(evaluateGate(scoped, config({ ignorePkgs: ['@scope/pkg'] })).violatingIssues).toHaveLength(0)
      })

      it('still reports a violating package the allowlist does not cover', () => {
        const result = evaluateGate(
          [
            { packageName: 'lodash', severity: 'critical', id: 'CVE-1' },
            { packageName: 'axios', severity: 'critical', id: 'CVE-2' },
          ],
          config({ ignorePkgs: ['lodash'] }),
        )

        expect(result.violatingIssues.map((i) => i.packageName)).toEqual(['axios'])
      })

      it('suppresses a __proto__ allowlist entry without polluting', () => {
        const result = evaluateGate(
          [{ packageName: '__proto__', severity: 'critical', id: 'CVE-1' }],
          config({ ignorePkgs: ['__proto__'] }),
        )

        // Array.includes does SameValueZero over own elements only, so this
        // genuinely suppresses rather than reading the prototype.
        expect(result.passed).toBe(true)
        expect(({} as Record<string, unknown>).severity).toBeUndefined()
      })
    })

    // -----------------------------------------------------------------------
    describe('CVE / Advisory Allowlist (P3, P4)', () => {
      it('suppresses an exactly matching id', () => {
        expect(
          evaluateGate(
            [{ packageName: 'p', severity: 'critical', id: 'CVE-1' }],
            config({ ignoreCves: ['CVE-1'] }),
          ).passed,
        ).toBe(true)
      })

      it('is case-sensitive', () => {
        expect(
          evaluateGate(
            [{ packageName: 'p', severity: 'critical', id: 'cve-1' }],
            config({ ignoreCves: ['CVE-1'] }),
          ).violatingIssues,
        ).toHaveLength(1)
      })

      it('does not match a prefix of a longer id', () => {
        expect(
          evaluateGate(
            [{ packageName: 'p', severity: 'critical', id: 'CVE-12345' }],
            config({ ignoreCves: ['CVE-1'] }),
          ).violatingIssues,
        ).toHaveLength(1)
      })

      it('suppresses the whole issue when any one packed id is allowlisted (P4)', () => {
        const result = evaluateGate(
          [{ packageName: 'p', severity: 'critical', id: '1096727, Advisory:p, CVE-9' }],
          config({ ignoreCves: ['CVE-9'] }),
        )

        expect(result.passed).toBe(true)
      })

      it('splits packed ids on comma-space only, not a bare comma', () => {
        // No space after the comma, so the id is one opaque token. parseNpmAudit
        // always joins with ', ', so this shape only arises from a hand-written
        // or third-party id.
        const result = evaluateGate(
          [{ packageName: 'p', severity: 'critical', id: 'CVE-1,CVE-2' }],
          config({ ignoreCves: ['CVE-2'] }),
        )

        expect(result.violatingIssues).toHaveLength(1)
      })

      it('trims whitespace around each packed id', () => {
        const result = evaluateGate(
          [{ packageName: 'p', severity: 'critical', id: 'CVE-1,   CVE-2' }],
          config({ ignoreCves: ['CVE-2'] }),
        )

        expect(result.passed).toBe(true)
      })

      it('suppresses an empty id via an empty-string allowlist entry', () => {
        // Only reachable by calling evaluateGate directly; parseArgs filters
        // empty entries out of the allowlist.
        expect(
          evaluateGate(
            [{ packageName: 'p', severity: 'critical', id: '' }],
            config({ ignoreCves: [''] }),
          ).passed,
        ).toBe(true)
      })

      it('does not suppress an empty id via a non-empty allowlist', () => {
        expect(
          evaluateGate(
            [{ packageName: 'p', severity: 'critical', id: '' }],
            config({ ignoreCves: ['CVE-1'] }),
          ).violatingIssues,
        ).toHaveLength(1)
      })
    })

    // -----------------------------------------------------------------------
    describe('Purity and Ordering (P5)', () => {
      it('does not mutate the issues array or its entries', () => {
        const issues: SecurityIssue[] = [
          { packageName: 'p', severity: 'critical', id: 'CVE-1', title: 'keep' },
        ]
        const snapshot = JSON.parse(JSON.stringify(issues)) as SecurityIssue[]

        evaluateGate(issues, config())

        expect(issues).toEqual(snapshot)
        expect(issues).toHaveLength(1)
      })

      it('does not mutate the config', () => {
        const cfg = config({ ignorePkgs: ['a'], ignoreCves: ['b'] })

        evaluateGate([{ packageName: 'p', severity: 'critical', id: 'CVE-1' }], cfg)

        expect(cfg).toEqual({ threshold: 'high', ignorePkgs: ['a'], ignoreCves: ['b'] })
      })

      it('preserves input order in violatingIssues', () => {
        const result = evaluateGate(
          [
            { packageName: 'c', severity: 'critical', id: 'CVE-1' },
            { packageName: 'a', severity: 'critical', id: 'CVE-2' },
            { packageName: 'b', severity: 'critical', id: 'CVE-3' },
          ],
          config(),
        )

        expect(result.violatingIssues.map((i) => i.packageName)).toEqual(['c', 'a', 'b'])
      })

      it('counts duplicate issues separately', () => {
        const dup: SecurityIssue = { packageName: 'p', severity: 'critical', id: 'CVE-1' }
        const result = evaluateGate([dup, dup, dup], config())

        expect(result.violatingIssues).toHaveLength(3)
        expect(result.passed).toBe(false)
      })

      it('is deterministic across 25 repeated calls', () => {
        const issues: SecurityIssue[] = SEVERITIES.map(([sev], i) => ({
          packageName: `p${i}`,
          severity: sev,
          id: `CVE-${i}`,
        }))
        const first = evaluateGate(issues, config({ threshold: 'medium' }))

        for (let i = 0; i < 25; i++) {
          expect(evaluateGate(issues, config({ threshold: 'medium' }))).toEqual(first)
        }
      })

      it('suppresses via the package allowlist even when the id allowlist misses', () => {
        const result = evaluateGate(
          [{ packageName: 'lodash', severity: 'critical', id: 'CVE-1' }],
          config({ ignorePkgs: ['lodash'], ignoreCves: ['other'] }),
        )

        expect(result.passed).toBe(true)
      })

      it('passes an empty issue list', () => {
        expect(evaluateGate([], config())).toEqual({ passed: true, violatingIssues: [] })
      })
    })

    // -----------------------------------------------------------------------
    describe('Malformed Input (fail-closed)', () => {
      it('throws a TypeError when an issue has no severity', () => {
        expect(() => evaluateGate([malformed({ packageName: 'p', id: 'CVE-1' })], config())).toThrow(
          TypeError,
        )
      })

      it('throws a TypeError when an issue has a null severity', () => {
        expect(() =>
          evaluateGate([malformed({ packageName: 'p', severity: null, id: 'CVE-1' })], config()),
        ).toThrow(TypeError)
      })

      it('throws a TypeError when ignorePkgs is missing', () => {
        expect(() =>
          evaluateGate(
            [{ packageName: 'p', severity: 'critical', id: 'CVE-1' }],
            malformed({ threshold: 'high', ignoreCves: [] }),
          ),
        ).toThrow(TypeError)
      })

      it('does not throw on a missing packageName — includes(undefined) is just false', () => {
        const issue = malformed({ severity: 'critical', id: 'CVE-1' })

        expect(evaluateGate([issue], config()).passed).toBe(false)
        // An absent packageName silently matches no allowlist entry rather than
        // raising, so an allowlist can never accidentally suppress it.
        expect(evaluateGate([issue], config({ ignorePkgs: ['x'] })).violatingIssues).toHaveLength(1)
      })

      it('throws a TypeError when the issue id is missing', () => {
        expect(() => evaluateGate([malformed({ packageName: 'p', severity: 'critical' })], config())).toThrow(
          TypeError,
        )
      })

      it('throws a TypeError immediately on a null id', () => {
        // Unlike a missing packageName, the id is dereferenced on every call,
        // so a null id aborts the gate before any allowlist is consulted.
        expect(() =>
          evaluateGate([malformed({ packageName: 'p', severity: 'critical', id: null })], config()),
        ).toThrow(TypeError)
        expect(() =>
          evaluateGate(
            [malformed({ packageName: 'p', severity: 'critical', id: null })],
            config({ ignoreCves: ['CVE-1'] }),
          ),
        ).toThrow(TypeError)
      })

      it('throws a TypeError when ignoreCves is missing', () => {
        expect(() =>
          evaluateGate(
            [{ packageName: 'p', severity: 'critical', id: 'CVE-1' }],
            malformed({ threshold: 'high', ignorePkgs: [] }),
          ),
        ).toThrow(TypeError)
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('parseArgs - Boundary Cases', () => {
    // -----------------------------------------------------------------------
    describe('Defaults', () => {
      it('returns the documented defaults for an empty argv', () => {
        expect(parseArgs([])).toEqual({
          file: '',
          threshold: 'high',
          ignorePkgs: [],
          ignoreCves: [],
          format: 'auto',
        })
      })

      it('ignores unrecognised flags entirely', () => {
        const parsed = parseArgs(['--verbose', '-x', 'positional', '--nope=1'])

        expect(parsed).toEqual(parseArgs([]))
      })

      it('returns a fresh allowlist array per call', () => {
        const first = parseArgs([])
        const second = parseArgs([])

        first.ignorePkgs.push('mutated')

        expect(second.ignorePkgs).toEqual([])
        expect(parseArgs([]).ignorePkgs).toEqual([])
      })
    })

    // -----------------------------------------------------------------------
    describe('Value Consuming (P6)', () => {
      it.each([
        ['--file', 'audit.json'],
        ['-f', 'audit.json'],
        ['--file=audit.json', null],
      ])('resolves the file flag via %s', (flag, inline) => {
        const argv = inline === null ? [flag] : [flag, inline]

        expect(parseArgs(argv).file).toBe('audit.json')
      })

      it('resolves an empty file flag to an empty string', () => {
        expect(parseArgs(['--file=']).file).toBe('')
        expect(parseArgs(['--file']).file).toBe('')
      })

      it('consumes the next token as the file value, even when it is a flag', () => {
        // argv[++i] consumes blindly, so --threshold is swallowed as the path
        // and 'high' is then seen as an unknown positional.
        const parsed = parseArgs(['--file', '--threshold', 'high'])

        expect(parsed.file).toBe('--threshold')
        expect(parsed.threshold).toBe('high')
      })

      it.each([
        ['--threshold', 'low'],
        ['-t', 'low'],
        ['--threshold=low', null],
      ])('resolves the threshold flag via %s', (flag, inline) => {
        const argv = inline === null ? [flag] : [flag, inline]

        expect(parseArgs(argv).threshold).toBe('low')
      })

      it('lower-cases the threshold value', () => {
        expect(parseArgs(['--threshold=CRITICAL']).threshold).toBe('critical')
        expect(parseArgs(['--threshold', 'High']).threshold).toBe('high')
      })

      it('accepts an unvalidated threshold verbatim', () => {
        // No validation against the GateConfig union happens here, so a typo
        // survives into evaluateGate, which then falls back to `high` (P2).
        expect(parseArgs(['--threshold=bogus']).threshold).toBe('bogus')
      })

      it.each([
        ['--format', 'trivy'],
        ['--format=trivy', null],
      ])('resolves the format flag via %s', (flag, inline) => {
        const argv = inline === null ? [flag] : [flag, inline]

        expect(parseArgs(argv).format).toBe('trivy')
      })

      it('does not lower-case the format value', () => {
        expect(parseArgs(['--format=Trivy']).format).toBe('Trivy')
      })
    })

    // -----------------------------------------------------------------------
    describe('Last-Wins Semantics (P6)', () => {
      it.each(['--file', '-f', '--file='])('repeats the file flag and takes the last value', (flag) => {
        const parsed =
          flag === '--file='
            ? parseArgs(['--file=first.json', '--file=second.json'])
            : parseArgs([flag, 'first.json', flag, 'second.json'])

        expect(parsed.file).toBe('second.json')
      })

      it('takes the last threshold when repeated', () => {
        expect(parseArgs(['--threshold=low', '--threshold=critical']).threshold).toBe('critical')
      })

      it('takes the last format when repeated', () => {
        expect(parseArgs(['--format=npm-audit', '--format=trivy']).format).toBe('trivy')
      })
    })

    // -----------------------------------------------------------------------
    describe('Allowlist Parsing (P6)', () => {
      it.each([
        ['--ignore-pkg', 'lodash,axios'],
        ['--ignore-pkg=lodash,axios'],
      ])('parses a package allowlist via %s', (flag, value) => {
        const argv = flag.includes('=') ? [flag] : [flag, value]

        expect(parseArgs(argv).ignorePkgs).toEqual(['lodash', 'axios'])
      })

      it.each([
        ['--ignore-cve', 'CVE-1,CVE-2'],
        ['--ignore-cve=CVE-1,CVE-2'],
      ])('parses a CVE allowlist via %s', (flag, value) => {
        const argv = flag.includes('=') ? [flag] : [flag, value]

        expect(parseArgs(argv).ignoreCves).toEqual(['CVE-1', 'CVE-2'])
      })

      it('trims whitespace and drops empty entries from an allowlist', () => {
        expect(parseArgs(['--ignore-pkg= lodash , , axios ,, ']).ignorePkgs).toEqual([
          'lodash',
          'axios',
        ])
      })

      it('resolves an empty allowlist flag to an empty array', () => {
        expect(parseArgs(['--ignore-pkg=']).ignorePkgs).toEqual([])
        expect(parseArgs(['--ignore-pkg']).ignorePkgs).toEqual([])
        expect(parseArgs(['--ignore-pkg=,,,']).ignorePkgs).toEqual([])
      })

      it('preserves duplicate allowlist entries verbatim', () => {
        expect(parseArgs(['--ignore-pkg=lodash,lodash']).ignorePkgs).toEqual(['lodash', 'lodash'])
      })

      it('REPLACES rather than accumulates on a repeated allowlist flag (P6)', () => {
        // A security-relevant footgun: a second --ignore-pkg silently discards
        // the first, so an allowlist that looks additive is not.
        const parsed = parseArgs(['--ignore-pkg=lodash', '--ignore-pkg=axios'])

        expect(parsed.ignorePkgs).toEqual(['axios'])
      })

      it('replaces the CVE allowlist on a repeated flag (P6)', () => {
        expect(parseArgs(['--ignore-cve=CVE-1', '--ignore-cve=CVE-2']).ignoreCves).toEqual(['CVE-2'])
      })

      it('does not cross-contaminate the two allowlists', () => {
        const parsed = parseArgs(['--ignore-pkg=lodash', '--ignore-cve=CVE-1'])

        expect(parsed.ignorePkgs).toEqual(['lodash'])
        expect(parsed.ignoreCves).toEqual(['CVE-1'])
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('readStdin - Recovery and Concurrency', () => {
    /** An EventEmitter standing in for process.stdin. */
    function fakeStdin(isTTY = false) {
      const stream = new EventEmitter() as EventEmitter & {
        isTTY: boolean
        setEncoding: ReturnType<typeof vi.fn>
      }
      stream.isTTY = isTTY
      stream.setEncoding = vi.fn()
      return stream
    }

    const originalStdin = process.stdin

    /** Replace process.stdin, returning a restore function. */
    function swapStdin(stream: unknown): () => void {
      Object.defineProperty(process, 'stdin', { value: stream, configurable: true })

      return () => {
        Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
      }
    }

    function withStdin<T>(stream: unknown, fn: () => Promise<T>): Promise<T> {
      const restore = swapStdin(stream)

      return fn().finally(restore)
    }

    /**
     * Race a promise against a timer. Used for the limitations below, where the
     * promise is *expected* never to settle, so the caller's own cleanup must
     * not depend on it. Distinguishes a rejection from a timeout.
     */
    async function settlesWithin<T>(
      promise: Promise<T>,
      ms = 50,
    ): Promise<{ status: 'resolved' | 'rejected' | 'pending'; value?: unknown }> {
      const timeout = new Promise<{ status: 'pending' }>((resolve) =>
        setTimeout(() => resolve({ status: 'pending' }), ms),
      )

      return Promise.race([
        promise.then((value) => ({ status: 'resolved' as const, value })),
        promise.catch((error: unknown) => ({ status: 'rejected' as const, value: error })),
        timeout,
      ])
    }

    afterAll(() => {
      // The never-settling cases restore explicitly, but a failure mid-test
      // could leave the fake installed and poison every later test.
      Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
    })

    it('resolves empty when stdin is a TTY', async () => {
      const stream = fakeStdin(true)

      await withStdin(stream, async () => {
        await expect(readStdin()).resolves.toBe('')
      })

      // A TTY short-circuits before any listener is attached.
      expect(stream.setEncoding).not.toHaveBeenCalled()
      expect(stream.listenerCount('data')).toBe(0)
    })

    it('accumulates data across many chunks in order', async () => {
      const stream = fakeStdin(false)
      const promise = withStdin(stream, () => readStdin())

      stream.emit('data', '{"a":')
      stream.emit('data', '1,')
      stream.emit('data', '"b":2}')
      stream.emit('end')

      await expect(promise).resolves.toBe('{"a":1,"b":2}')
    })

    it('resolves empty when stdin ends with no data', async () => {
      const stream = fakeStdin(false)
      const promise = withStdin(stream, () => readStdin())

      stream.emit('end')

      await expect(promise).resolves.toBe('')
    })

    it('sets utf-8 encoding on the stream', async () => {
      const stream = fakeStdin(false)
      const promise = withStdin(stream, () => readStdin())

      stream.emit('end')

      await promise

      expect(stream.setEncoding).toHaveBeenCalledWith('utf-8')
    })

    it('ignores data arriving after end', async () => {
      const stream = fakeStdin(false)
      const promise = withStdin(stream, () => readStdin())

      stream.emit('data', 'kept')
      stream.emit('end')
      stream.emit('data', 'discarded')

      await expect(promise).resolves.toBe('kept')
    })

    it('resolves both concurrent readers with the full content', async () => {
      // Each call attaches its own listeners, so a broadcast source feeds both.
      const stream = fakeStdin(false)
      const promise = withStdin(stream, async () => {
        const first = readStdin()
        const second = readStdin()

        stream.emit('data', 'shared')
        stream.emit('end')

        return Promise.all([first, second])
      })

      await expect(promise).resolves.toEqual(['shared', 'shared'])
    })

    it('never settles on a stream error (S5)', async () => {
      const stream = fakeStdin(false)
      // A real EventEmitter rethrows an unlistened 'error' synchronously, which
      // would mask the behaviour under test. Swallow it so the assertion
      // observes the gate's reaction rather than Node's default.
      stream.on('error', () => {})

      const restore = swapStdin(stream)
      const pending = readStdin()

      stream.emit('error', new Error('stdin exploded'))
      const outcome = await settlesWithin(pending)
      restore()

      // Documented limitation S5: no 'error' listener is registered by
      // readStdin, so the promise stays pending instead of rejecting. In a real
      // pipeline this is a hang, not a failure — the CI job stalls rather than
      // reporting a red build.
      expect(outcome).toEqual({ status: 'pending' })
    })

    it('never settles when called after stdin has already ended (S6)', async () => {
      const stream = fakeStdin(false)
      const restore = swapStdin(stream)

      stream.emit('end')
      const pending = readStdin()
      const outcome = await settlesWithin(pending)
      restore()

      // Documented limitation S6: the 'end' event has already fired, so the
      // listener attached afterwards never runs and the read never completes.
      expect(outcome).toEqual({ status: 'pending' })
    })

    it('restores process.stdin after the never-settling cases (regression guard)', () => {
      // The two tests above restore explicitly because a never-settling promise
      // cannot run a `finally`. This pins that they actually did.
      expect(process.stdin).toBe(originalStdin)
    })
  })

  // -------------------------------------------------------------------------
  describe('CLI Exit-Code and Diagnostics Contract (P8)', () => {
    // -----------------------------------------------------------------------
    describe('Pass and Fail Paths', () => {
      it('exits 0 and reports PASSED on a clean report', async () => {
        const run = await runGate(['--file', fixture('clean.json', CLEAN_NPM)])

        expect(run.code).toBe(0)
        expect(run.stdout).toContain('PASSED')
        expect(run.stdout).toContain('No policy-violating vulnerabilities found')
      }, 60_000)

      it('exits 1 and enumerates a violating finding', async () => {
        const run = await runGate(['--file', fixture('crit.json', CRITICAL_NPM)])

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('FAILED')
        expect(run.stderr).toContain('lodash')
        expect(run.stderr).toContain('CRITICAL')
        expect(run.stderr).toContain('1096727')
        expect(run.stderr).toContain('4.17.21')
      }, 60_000)

      it('fails a critical finding at the critical threshold (inclusive, P1)', async () => {
        const run = await runGate([
          '--file',
          fixture('crit2.json', CRITICAL_NPM),
          '--threshold',
          'critical',
        ])

        expect(run.code).toBe(1)
      }, 60_000)

      it('announces the configured threshold', async () => {
        const run = await runGate([
          '--file',
          fixture('clean2.json', CLEAN_NPM),
          '--threshold',
          'medium',
        ])

        expect(run.stdout).toContain('Fail on MEDIUM or higher severity')
      }, 60_000)

      it('reads a report from stdin', async () => {
        const run = await runGate(['--format', 'npm-audit'], CRITICAL_NPM)

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('FAILED')
      }, 60_000)
    })

    // -----------------------------------------------------------------------
    describe('Allowlist End to End', () => {
      it('exits 0 when the violating package is allowlisted', async () => {
        const run = await runGate([
          '--file',
          fixture('crit3.json', CRITICAL_NPM),
          '--ignore-pkg',
          'lodash',
        ])

        expect(run.code).toBe(0)
        expect(run.stdout).toContain('Ignoring packages: lodash')
      }, 60_000)

      it('exits 0 when the CVE is allowlisted', async () => {
        const run = await runGate([
          '--file',
          fixture('crit4.json', CRITICAL_NPM),
          '--ignore-cve',
          '1096727',
        ])

        expect(run.code).toBe(0)
      }, 60_000)

      it('exits 1 when the allowlist names a different package', async () => {
        const run = await runGate([
          '--file',
          fixture('crit5.json', CRITICAL_NPM),
          '--ignore-pkg',
          'express',
        ])

        expect(run.code).toBe(1)
      }, 60_000)
    })

    // -----------------------------------------------------------------------
    describe('Format Detection', () => {
      it('auto-detects an npm-audit report', async () => {
        const run = await runGate(['--file', fixture('auto-npm.json', CRITICAL_NPM)])

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('lodash')
      }, 60_000)

      it('auto-detects a Trivy report', async () => {
        const run = await runGate(['--file', fixture('auto-trivy.json', CRITICAL_TRIVY)])

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('axios')
        expect(run.stderr).toContain('CVE-2023-45133')
      }, 60_000)

      it('exits 1 with a diagnostic when auto-detection fails', async () => {
        const run = await runGate(['--file', fixture('neither.json', '{"hello":"world"}')])

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('Could not auto-detect report format')
        expect(run.stderr).toContain('--format=npm-audit')
      }, 60_000)

      it('exits 1 with a diagnostic on malformed JSON', async () => {
        const run = await runGate(['--file', fixture('bad.json', '{not json')])

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('Error parsing JSON content')
      }, 60_000)
    })

    // -----------------------------------------------------------------------
    describe('Input and Usage Errors (fail-closed)', () => {
      it('exits 1 when the report file does not exist', async () => {
        const run = await runGate(['--file', path.join(tmpDir, 'nope.json')])

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('File not found')
      }, 60_000)

      it('exits 1 with usage text when no file and no stdin data', async () => {
        const run = await runGate([])

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('No input file specified')
        expect(run.stderr).toContain('Usage:')
      }, 60_000)

      it('exits 1 with usage text when only whitespace is piped', async () => {
        // Blank stdin is caught by main()'s own input guard, before any parsing.
        // This path is fail-closed.
        const run = await runGate(['--format', 'npm-audit'], '   ')

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('No input file specified')
      }, 60_000)

      it('exits 0 on an empty report FILE with an explicit format (S4)', async () => {
        // Documented limitation S4: once --file is given, the stdin guard is
        // skipped, so a truncated, empty or mis-generated report file parses as
        // zero findings and the gate reports PASSED. A CI job whose scanner
        // silently wrote nothing is indistinguishable from a clean scan.
        const run = await runGate(['--file', fixture('s4.json', ''), '--format=npm-audit'])

        expect(run.code).toBe(0)
        expect(run.stdout).toContain('Evaluating 0 vulnerability findings')
        expect(run.stdout).toContain('PASSED')
      }, 60_000)

      it('exits 1 on an empty report file under auto-detect', async () => {
        // Without an explicit format the empty content reaches auto-detection,
        // where JSON.parse('') throws first. Fail-closed, but the message is a
        // parse error rather than a report-format diagnostic.
        const run = await runGate(['--file', fixture('s4b.json', '')])

        expect(run.code).toBe(1)
        expect(run.stderr).toContain('Error parsing JSON content')
      }, 60_000)
    })

    // -----------------------------------------------------------------------
    describe('FAIL-OPEN: Unrecognised Format (S1)', () => {
      it('reports PASSED and exits 0 for an unknown --format value', async () => {
        // The report below contains a CRITICAL finding that fails the gate when
        // parsed correctly. An unrecognised --format leaves `issues` empty, so
        // the gate prints PASSED and exits 0. This is the most dangerous path in
        // the module: a typo in a CI workflow silently disables the control
        // while still reporting success.
        const run = await runGate(['--file', fixture('s1.json', CRITICAL_NPM), '--format=bogus'])

        expect(run.stdout).toContain('Evaluating 0 vulnerability findings')
        expect(run.stdout).toContain('PASSED')
        expect(run.code).toBe(0)
      }, 60_000)

      it('reports PASSED and exits 0 for an empty --format value', async () => {
        const run = await runGate(['--file', fixture('s1b.json', CRITICAL_NPM), '--format='])

        expect(run.code).toBe(0)
        expect(run.stdout).toContain('PASSED')
      }, 60_000)

      it('reports PASSED and exits 0 when the wrong parser is selected (S2)', async () => {
        const run = await runGate(['--file', fixture('s2.json', CRITICAL_NPM), '--format=trivy'])

        expect(run.stdout).toContain('Evaluating 0 vulnerability findings')
        expect(run.code).toBe(0)
      }, 60_000)

      it('is case-sensitive about --format, so Trivy does not match trivy', async () => {
        const run = await runGate(['--file', fixture('s2b.json', CRITICAL_NPM), '--format=Trivy'])

        expect(run.code).toBe(0)
        expect(run.stdout).toContain('Evaluating 0 vulnerability findings')
      }, 60_000)
    })

    // -----------------------------------------------------------------------
    describe('Determinism and Output Hygiene', () => {
      it('produces an identical exit code and verdict across repeated runs', async () => {
        const file = fixture('det.json', CRITICAL_NPM)
        const codes: Array<number | null> = []
        const verdicts: string[] = []

        for (let i = 0; i < 3; i++) {
          const run = await runGate(['--file', file, '--threshold', 'high'])
          codes.push(run.code)
          verdicts.push(run.stderr.includes('FAILED') ? 'FAILED' : 'PASSED')
        }

        expect(codes).toEqual([1, 1, 1])
        expect(new Set(verdicts)).toEqual(new Set(['FAILED']))
      }, 90_000)

      it('does not leak environment secrets into its output', async () => {
        const run = await runGate(['--file', fixture('hygiene.json', CRITICAL_NPM)])

        expect(`${run.stdout}${run.stderr}`).not.toMatch(/password|secret|token|api[_-]?key/i)
      }, 60_000)

      it('reports the finding count so a zero-count pass is visible', async () => {
        const run = await runGate(['--file', fixture('count.json', CLEAN_NPM)])

        expect(run.stdout).toContain('Evaluating 1 vulnerability findings')
      }, 60_000)
    })
  })
})
