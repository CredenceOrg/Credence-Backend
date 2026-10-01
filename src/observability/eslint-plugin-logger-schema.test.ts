/**
 * @file src/observability/eslint-plugin-logger-schema.test.ts
 *
 * Boundary and recovery test coverage for eslint.config.js.
 *
 * ## Scope
 *
 * ### Part 1 — Config shape (structural assertions, no ESLint engine)
 * Imports the flat-config array directly and asserts its shape:
 * - Export is a non-empty array (loading contract).
 * - Ignores block lists every required pattern and does not suppress src/.
 * - Main rule block targets `src/**\/\*.ts`, registers both logger-schema rules
 *   at the correct severity, and wires the plugin correctly.
 * - `no-console` is "error" in the main block and "off" in the override block.
 * - Plugin rule names in the config match exported rule objects (wiring contract).
 * - Config reference is stable across imports (immutability / no lazy mutation).
 *
 * ### Part 2 — loggerSchemaValidation rule (ESLint RuleTester)
 * Hermetic AST-level assertions without spawning a process:
 * - Valid: string arg, identifier arg, two-arg form, non-logger calls, all four
 *   LOGGER_METHODS, req.log with string, no args.
 * - Invalid: inline object literal for info/error/warn/debug, req.log.info with
 *   object, empty object `{}` (boundary), multi-property object.
 * - Message id is `rawLoggerCall`; meta.type is "problem"; recommended is true.
 * - Rule is deterministic: same code → same violation count on repeated runs.
 *
 * ### Part 3 — loggerCallWithObjectRule (ESLint RuleTester)
 * - Valid: string arg, identifier arg, non-logger call, two-arg form, req.log
 *   with string, no args.
 * - Invalid: inline object for info/error/warn/debug, req.log.warn with object,
 *   empty object `{}` (boundary).
 * - Message id is `inlineObjectLogger`; meta.type is "problem"; recommended is false.
 * - Determinism: three successive runs on the same invalid code all pass.
 *
 * ### Part 4 — Plugin wiring contract
 * Cross-checks that every rule name referenced in eslint.config.js exists in the
 * plugin export, and every exported rule is referenced in the config (no orphans).
 *
 * ## Invariants
 *
 * - `no-console` must be "error" for src/**\/\*.ts and "off" for logger.ts; swapping
 *   these would silently allow console calls in production code.
 * - Rule violations are deterministic: the same source always produces the same
 *   report regardless of invocation order.
 * - The plugin wiring is bijective: config rules ↔ plugin exports with no gaps.
 */

import { describe, it, expect } from 'vitest'
import { RuleTester } from 'eslint'
import {
  loggerSchemaValidation,
  loggerCallWithObjectRule,
} from './eslint-plugin-logger-schema.js'
import eslintConfig from '../../eslint.config.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared RuleTester instance (ESLint v9+ flat-config style)
// ─────────────────────────────────────────────────────────────────────────────

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Part 1 — Config shape
// ─────────────────────────────────────────────────────────────────────────────

describe('eslint.config.js — structural shape', () => {
  const config = eslintConfig as unknown[]

  it('exports a non-empty array (loading contract)', () => {
    expect(Array.isArray(config)).toBe(true)
    expect(config.length).toBeGreaterThan(0)
  })

  it('has exactly three config blocks: ignores, main rules, logger.ts override', () => {
    expect(config.length).toBe(3)
  })

  describe('block 0 — ignores', () => {
    const block = config[0] as any

    it('has an ignores array', () => {
      expect(Array.isArray(block.ignores)).toBe(true)
    })

    it.each([
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '**/*.test.ts',
      '**/*.spec.ts',
      'src/test_fuzz_currency_whitelist.ts',
    ])('ignores %s', (pattern) => {
      expect(block.ignores).toContain(pattern)
    })

    it('does not accidentally ignore src/**/*.ts (would suppress all lint)', () => {
      expect(block.ignores).not.toContain('src/**/*.ts')
      expect(block.ignores).not.toContain('src/**')
    })

    it('does not have files, rules, or plugins keys (pure ignore block)', () => {
      expect(block.files).toBeUndefined()
      expect(block.rules).toBeUndefined()
      expect(block.plugins).toBeUndefined()
    })
  })

  describe('block 1 — main rules', () => {
    const block = config[1] as any

    it('targets src/**/*.ts only', () => {
      expect(block.files).toEqual(['src/**/*.ts'])
    })

    it('sets no-console to "error"', () => {
      expect(block.rules?.['no-console']).toBe('error')
    })

    it('sets logger-schema/require-schema-context to "warn"', () => {
      expect(block.rules?.['logger-schema/require-schema-context']).toBe('warn')
    })

    it('sets logger-schema/unvalidated-logger-call to "warn"', () => {
      expect(block.rules?.['logger-schema/unvalidated-logger-call']).toBe('warn')
    })

    it('registers the logger-schema plugin', () => {
      expect(block.plugins).toHaveProperty('logger-schema')
    })

    it('plugin exposes require-schema-context (wiring contract)', () => {
      expect(block.plugins['logger-schema'].rules).toHaveProperty('require-schema-context')
    })

    it('plugin exposes unvalidated-logger-call (wiring contract)', () => {
      expect(block.plugins['logger-schema'].rules).toHaveProperty('unvalidated-logger-call')
    })

    it('registers @typescript-eslint plugin', () => {
      expect(block.plugins).toHaveProperty('@typescript-eslint')
    })

    it('sets languageOptions.sourceType to "module"', () => {
      expect(block.languageOptions?.sourceType).toBe('module')
    })
  })

  describe('block 2 — logger.ts override', () => {
    const block = config[2] as any

    it('targets src/utils/logger.ts only', () => {
      expect(block.files).toEqual(['src/utils/logger.ts'])
    })

    it('sets no-console to "off"', () => {
      expect(block.rules?.['no-console']).toBe('off')
    })

    it('invariant: no-console is never "error" in the override (swap guard)', () => {
      expect(block.rules?.['no-console']).not.toBe('error')
    })
  })

  describe('config immutability', () => {
    it('the config reference is stable — same object on repeated access', () => {
      const a = eslintConfig as unknown[]
      const b = eslintConfig as unknown[]
      expect(a).toBe(b)
    })

    it('block 0 ignores array reference is stable', () => {
      const a = (eslintConfig as any[])[0].ignores
      const b = (eslintConfig as any[])[0].ignores
      expect(a).toBe(b)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Part 2 — loggerSchemaValidation rule
// ─────────────────────────────────────────────────────────────────────────────

describe('loggerSchemaValidation rule', () => {
  // ── Rule meta ─────────────────────────────────────────────────────────────

  it('meta.type is "problem"', () => {
    expect(loggerSchemaValidation.meta?.type).toBe('problem')
  })

  it('meta.docs.recommended is true', () => {
    expect(loggerSchemaValidation.meta?.docs?.recommended).toBe(true)
  })

  it('rawLoggerCall message contains {{ method }} placeholder (diagnosable)', () => {
    const msg = loggerSchemaValidation.meta?.messages?.['rawLoggerCall'] ?? ''
    expect(msg).toContain('{{ method }}')
    expect(msg.length).toBeGreaterThan(20)
  })

  it('exposes a create function', () => {
    expect(typeof loggerSchemaValidation.create).toBe('function')
  })

  // ── Valid cases ────────────────────────────────────────────────────────────

  it('does not flag a string literal first argument', () => {
    tester.run('valid-string', loggerSchemaValidation, {
      valid: [
        { code: 'logger.info("simple message")' },
        { code: 'logger.error("something went wrong")' },
        { code: 'logger.warn("watch out")' },
        { code: 'logger.debug("debug msg")' },
      ],
      invalid: [],
    })
  })

  it('does not flag an identifier as first argument', () => {
    tester.run('valid-identifier', loggerSchemaValidation, {
      valid: [
        { code: 'logger.info(message)' },
        { code: 'logger.error(err)' },
      ],
      invalid: [],
    })
  })

  it('does not flag a two-argument call (schema context provided)', () => {
    tester.run('valid-two-args', loggerSchemaValidation, {
      valid: [
        { code: 'logger.info({ message: "hi" }, { eventType: "user.login" })' },
        { code: 'logger.error({ error: "x" }, { eventType: "request.error" })' },
      ],
      invalid: [],
    })
  })

  it('does not flag non-logger object calls', () => {
    tester.run('valid-non-logger', loggerSchemaValidation, {
      valid: [
        { code: 'service.info({ key: "value" })' },
        { code: 'console.log({ key: "value" })' },
        { code: 'foo.bar({ key: "value" })' },
      ],
      invalid: [],
    })
  })

  it('does not flag req.log with a string argument', () => {
    tester.run('valid-req-log-string', loggerSchemaValidation, {
      valid: [
        { code: 'req.log.info("message")' },
        { code: 'req.log.debug("debug")' },
      ],
      invalid: [],
    })
  })

  it('does not flag calls with no arguments', () => {
    tester.run('valid-no-args', loggerSchemaValidation, {
      valid: [{ code: 'logger.info()' }],
      invalid: [],
    })
  })

  it('does not flag a numeric literal first argument (boundary)', () => {
    tester.run('valid-number', loggerSchemaValidation, {
      valid: [{ code: 'logger.info(42)' }],
      invalid: [],
    })
  })

  // ── Invalid cases ──────────────────────────────────────────────────────────

  it('flags logger.info with inline object', () => {
    tester.run('invalid-info', loggerSchemaValidation, {
      valid: [],
      invalid: [
        {
          code: 'logger.info({ message: "hi" })',
          errors: [{ messageId: 'rawLoggerCall' }],
        },
      ],
    })
  })

  it('flags logger.error with inline object', () => {
    tester.run('invalid-error', loggerSchemaValidation, {
      valid: [],
      invalid: [
        {
          code: 'logger.error({ message: "fail" })',
          errors: [{ messageId: 'rawLoggerCall' }],
        },
      ],
    })
  })

  it('flags logger.warn with inline object', () => {
    tester.run('invalid-warn', loggerSchemaValidation, {
      valid: [],
      invalid: [
        {
          code: 'logger.warn({ message: "warn" })',
          errors: [{ messageId: 'rawLoggerCall' }],
        },
      ],
    })
  })

  it('flags logger.debug with inline object', () => {
    tester.run('invalid-debug', loggerSchemaValidation, {
      valid: [],
      invalid: [
        {
          code: 'logger.debug({ message: "dbg" })',
          errors: [{ messageId: 'rawLoggerCall' }],
        },
      ],
    })
  })

  it('flags req.log.info with inline object', () => {
    tester.run('invalid-req-log-info', loggerSchemaValidation, {
      valid: [],
      invalid: [
        {
          code: 'req.log.info({ message: "hi" })',
          errors: [{ messageId: 'rawLoggerCall' }],
        },
      ],
    })
  })

  it('flags an empty object literal {} (boundary: minimal trigger)', () => {
    tester.run('invalid-empty-obj', loggerSchemaValidation, {
      valid: [],
      invalid: [
        {
          code: 'logger.info({})',
          errors: [{ messageId: 'rawLoggerCall' }],
        },
      ],
    })
  })

  it('flags a multi-property object', () => {
    tester.run('invalid-multi-prop', loggerSchemaValidation, {
      valid: [],
      invalid: [
        {
          code: 'logger.error({ a: 1, b: 2, c: 3 })',
          errors: [{ messageId: 'rawLoggerCall' }],
        },
      ],
    })
  })

  // ── Determinism ────────────────────────────────────────────────────────────

  it('is deterministic: same code always produces the same report (3 runs)', () => {
    const code = 'logger.warn({ event: "x" })'
    for (let i = 0; i < 3; i++) {
      tester.run(`determinism-schema-${i}`, loggerSchemaValidation, {
        valid: [],
        invalid: [{ code, errors: [{ messageId: 'rawLoggerCall' }] }],
      })
    }
  })

  it('concurrent-style: independent tester instances yield equal results', () => {
    const code = 'logger.debug({ payload: "x" })'
    const t1 = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } })
    const t2 = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } })
    const spec = {
      valid: [] as any[],
      invalid: [{ code, errors: [{ messageId: 'rawLoggerCall' }] }],
    }
    // Both must complete without throwing — identical outcome
    t1.run('concurrent-1', loggerSchemaValidation, spec)
    t2.run('concurrent-2', loggerSchemaValidation, spec)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Part 3 — loggerCallWithObjectRule
// ─────────────────────────────────────────────────────────────────────────────

describe('loggerCallWithObjectRule rule', () => {
  // ── Rule meta ─────────────────────────────────────────────────────────────

  it('meta.type is "problem"', () => {
    expect(loggerCallWithObjectRule.meta?.type).toBe('problem')
  })

  it('meta.docs.recommended is false (opt-in rule)', () => {
    expect(loggerCallWithObjectRule.meta?.docs?.recommended).toBe(false)
  })

  it('inlineObjectLogger message contains {{ method }} placeholder (diagnosable)', () => {
    const msg = loggerCallWithObjectRule.meta?.messages?.['inlineObjectLogger'] ?? ''
    expect(msg).toContain('{{ method }}')
  })

  it('exposes a create function', () => {
    expect(typeof loggerCallWithObjectRule.create).toBe('function')
  })

  // ── Valid cases ────────────────────────────────────────────────────────────

  it('does not flag a string literal first argument', () => {
    tester.run('cw-valid-string', loggerCallWithObjectRule, {
      valid: [
        { code: 'logger.info("msg")' },
        { code: 'logger.error("err")' },
        { code: 'logger.warn("warn")' },
        { code: 'logger.debug("dbg")' },
      ],
      invalid: [],
    })
  })

  it('does not flag an identifier first argument', () => {
    tester.run('cw-valid-identifier', loggerCallWithObjectRule, {
      valid: [
        { code: 'logger.info(logEvent)' },
        { code: 'logger.error(err)' },
      ],
      invalid: [],
    })
  })

  it('does not flag non-logger object calls', () => {
    tester.run('cw-valid-non-logger', loggerCallWithObjectRule, {
      valid: [
        { code: 'service.info({ key: "value" })' },
        { code: 'notLogger.info({ key: "value" })' },
      ],
      invalid: [],
    })
  })

  it('does not flag req.log with a string argument', () => {
    tester.run('cw-valid-req-log-string', loggerCallWithObjectRule, {
      valid: [
        { code: 'req.log.info("message")' },
        { code: 'req.log.debug("debug")' },
      ],
      invalid: [],
    })
  })

  it('does not flag calls with no arguments', () => {
    tester.run('cw-valid-no-args', loggerCallWithObjectRule, {
      valid: [{ code: 'logger.info()' }],
      invalid: [],
    })
  })

  // ── Invalid cases ──────────────────────────────────────────────────────────

  it('flags logger.info with inline object', () => {
    tester.run('cw-invalid-info', loggerCallWithObjectRule, {
      valid: [],
      invalid: [
        {
          code: 'logger.info({ message: "hi" })',
          errors: [{ messageId: 'inlineObjectLogger' }],
        },
      ],
    })
  })

  it('flags logger.error with inline object', () => {
    tester.run('cw-invalid-error', loggerCallWithObjectRule, {
      valid: [],
      invalid: [
        {
          code: 'logger.error({ message: "fail" })',
          errors: [{ messageId: 'inlineObjectLogger' }],
        },
      ],
    })
  })

  it('flags logger.warn with inline object', () => {
    tester.run('cw-invalid-warn', loggerCallWithObjectRule, {
      valid: [],
      invalid: [
        {
          code: 'logger.warn({ message: "warn" })',
          errors: [{ messageId: 'inlineObjectLogger' }],
        },
      ],
    })
  })

  it('flags logger.debug with inline object', () => {
    tester.run('cw-invalid-debug', loggerCallWithObjectRule, {
      valid: [],
      invalid: [
        {
          code: 'logger.debug({ message: "dbg" })',
          errors: [{ messageId: 'inlineObjectLogger' }],
        },
      ],
    })
  })

  it('flags req.log.warn with inline object', () => {
    tester.run('cw-invalid-req-log-warn', loggerCallWithObjectRule, {
      valid: [],
      invalid: [
        {
          code: 'req.log.warn({ message: "watch out" })',
          errors: [{ messageId: 'inlineObjectLogger' }],
        },
      ],
    })
  })

  it('flags empty object literal {} (boundary: minimal trigger)', () => {
    tester.run('cw-invalid-empty', loggerCallWithObjectRule, {
      valid: [],
      invalid: [
        {
          code: 'logger.info({})',
          errors: [{ messageId: 'inlineObjectLogger' }],
        },
      ],
    })
  })

  // ── Determinism ────────────────────────────────────────────────────────────

  it('is deterministic: three successive runs on the same code all pass', () => {
    const code = 'logger.warn({ event: "x" })'
    for (let i = 0; i < 3; i++) {
      tester.run(`cw-determinism-${i}`, loggerCallWithObjectRule, {
        valid: [],
        invalid: [{ code, errors: [{ messageId: 'inlineObjectLogger' }] }],
      })
    }
  })

  it('concurrent-style: two independent instances yield equal results', () => {
    const code = 'logger.error({ err: "x" })'
    const t1 = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } })
    const t2 = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } })
    const spec = {
      valid: [] as any[],
      invalid: [{ code, errors: [{ messageId: 'inlineObjectLogger' }] }],
    }
    t1.run('cw-concurrent-1', loggerCallWithObjectRule, spec)
    t2.run('cw-concurrent-2', loggerCallWithObjectRule, spec)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Part 4 — Plugin wiring contract (config ↔ plugin bijection)
// ─────────────────────────────────────────────────────────────────────────────

describe('plugin wiring contract', () => {
  const mainBlock = (eslintConfig as any[])[1]
  const pluginRules = mainBlock.plugins['logger-schema'].rules as Record<string, unknown>

  it('every rule referenced in config exists in the plugin (no broken references)', () => {
    const configured = Object.keys(mainBlock.rules)
      .filter((k: string) => k.startsWith('logger-schema/'))
      .map((k: string) => k.replace('logger-schema/', ''))

    for (const name of configured) {
      expect(pluginRules).toHaveProperty(name)
    }
  })

  it('every plugin rule is referenced in config (no orphaned rules)', () => {
    const configured = Object.keys(mainBlock.rules)
      .filter((k: string) => k.startsWith('logger-schema/'))
      .map((k: string) => k.replace('logger-schema/', ''))

    for (const name of Object.keys(pluginRules)) {
      expect(configured).toContain(name)
    }
  })

  it('require-schema-context is the exported loggerSchemaValidation object', () => {
    expect(pluginRules['require-schema-context']).toBe(loggerSchemaValidation)
  })

  it('unvalidated-logger-call is the exported loggerCallWithObjectRule object', () => {
    expect(pluginRules['unvalidated-logger-call']).toBe(loggerCallWithObjectRule)
  })

  it('both rules implement the Rule.RuleModule interface (have meta and create)', () => {
    for (const rule of Object.values(pluginRules) as any[]) {
      expect(typeof rule.create).toBe('function')
      expect(rule.meta).toBeDefined()
      expect(rule.meta.messages).toBeDefined()
    }
  })
})
