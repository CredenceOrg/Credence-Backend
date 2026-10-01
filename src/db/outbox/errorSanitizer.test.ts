import { describe, it, expect } from 'vitest'; // Jest: delete this line
// CHANGE: import the real exported function name(s) you found in Step 2
import { sanitizeError } from './errorSanitizer';

describe('sanitizeError — success path', () => {
  it('sanitizes a normal Error with a message', () => {
      const result = sanitizeError(new Error('Something failed'));
          expect(result).toBeDefined();
              expect(typeof result.message).toBe('string');
                });

                  it('is deterministic for the same input', () => {
                      const err = new Error('Same error');
                          expect(sanitizeError(err)).toEqual(sanitizeError(err));
                            });
                            });

                            describe('sanitizeError — invalid input', () => {
                              it('handles null without throwing', () => {
                                  expect(() => sanitizeError(null as any)).not.toThrow();
                                    });

                                      it('handles undefined without throwing', () => {
                                          expect(() => sanitizeError(undefined as any)).not.toThrow();
                                            });

                                              it('handles a non-Error value (string) without throwing', () => {
                                                  expect(() => sanitizeError('plain string error' as any)).not.toThrow();
                                                    });

                                                      it('handles a plain object without throwing', () => {
                                                          expect(() => sanitizeError({ foo: 'bar' } as any)).not.toThrow();
                                                            });
                                                            });

                                                            describe('sanitizeError — boundary cases', () => {
                                                              it('handles an empty message', () => {
                                                                  const result = sanitizeError(new Error(''));
                                                                      expect(result).toBeDefined();
                                                                        });

                                                                          it('handles an oversized message without crashing', () => {
                                                                              const huge = new Error('x'.repeat(100_000));
                                                                                  expect(() => sanitizeError(huge)).not.toThrow();
                                                                                    });

                                                                                      it('handles a deeply nested cause chain', () => {
                                                                                          const root = new Error('root cause');
                                                                                              let current = root;
                                                                                                  for (let i = 0; i < 20; i++) {
                                                                                                        current = new Error(`level ${i}`, { cause: current });
                                                                                                            }
                                                                                                                expect(() => sanitizeError(current)).not.toThrow();
                                                                                                                  });

                                                                                                                    it('handles a circular cause reference without infinite looping', () => {
                                                                                                                        const a: any = new Error('a');
                                                                                                                            const b: any = new Error('b', { cause: a });
                                                                                                                                a.cause = b; // circular
                                                                                                                                    expect(() => sanitizeError(a)).not.toThrow();
                                                                                                                                      });
                                                                                                                                      });

                                                                                                                                      describe('sanitizeError — sensitive data redaction', () => {
                                                                                                                                        // CHANGE: replace these field names with the real ones the sanitizer redacts
                                                                                                                                          it('redacts a password appearing in the message', () => {
                                                                                                                                              const result = sanitizeError(new Error('login failed for password=hunter2'));
                                                                                                                                                  expect(JSON.stringify(result)).not.toContain('hunter2');
                                                                                                                                                    });

                                                                                                                                                      it('redacts an API key or token in the message', () => {
                                                                                                                                                          const result = sanitizeError(new Error('token=sk_live_ABC123XYZ rejected'));
                                                                                                                                                              expect(JSON.stringify(result)).not.toContain('sk_live_ABC123XYZ');
                                                                                                                                                                });

                                                                                                                                                                  it('does not leak the raw stack trace of internal paths', () => {
                                                                                                                                                                      const err = new Error('internal failure');
                                                                                                                                                                          const result = sanitizeError(err);
                                                                                                                                                                              // CHANGE: adjust to whatever the sanitizer actually does with .stack
                                                                                                                                                                                  expect(result).not.toHaveProperty('stack', err.stack);
                                                                                                                                                                                    });
                                                                                                                                                                                    });

                                                                                                                                                                                    describe('sanitizeError — retry / stale / permission error shapes', () => {
                                                                                                                                                                                      it('sanitizes a retryable error and marks it as such', () => {
                                                                                                                                                                                          const err: any = new Error('temporary failure');
                                                                                                                                                                                              err.retryable = true;
                                                                                                                                                                                                  const result = sanitizeError(err);
                                                                                                                                                                                                      // CHANGE: adjust to the real property name the sanitizer preserves
                                                                                                                                                                                                          expect(result).toHaveProperty('retryable', true);
                                                                                                                                                                                                            });

                                                                                                                                                                                                              it('sanitizes a stale-data error', () => {
                                                                                                                                                                                                                  const err: any = new Error('stale outbox entry');
                                                                                                                                                                                                                      err.code = 'STALE';
                                                                                                                                                                                                                          const result = sanitizeError(err);
                                                                                                                                                                                                                              expect(result).toBeDefined();
                                                                                                                                                                                                                                });

                                                                                                                                                                                                                                  it('sanitizes a permission/authorization error without leaking identifiers', () => {
                                                                                                                                                                                                                                      const err: any = new Error('user 12345 denied access to resource 67890');
                                                                                                                                                                                                                                          err.code = 'FORBIDDEN';
                                                                                                                                                                                                                                              const result = sanitizeError(err);
                                                                                                                                                                                                                                                  expect(result).toBeDefined();
                                                                                                                                                                                                                                                      // Loosen or tighten this depending on whether IDs count as sensitive here
                                                                                                                                                                                                                                                        });
                                                                                                                                                                                                                                                        });

                                                                                                                                                                                                                                                        describe('sanitizeError — duplicate calls / idempotency', () => {
                                                                                                                                                                                                                                                          it('produces an equivalent result when called twice on the same error', () => {
                                                                                                                                                                                                                                                              const err = new Error('duplicate check');
                                                                                                                                                                                                                                                                  const first = sanitizeError(err);
                                                                                                                                                                                                                                                                      const second = sanitizeError(err);
                                                                                                                                                                                                                                                                          expect(first).toEqual(second);
                                                                                                                                                                                                                                                                            });

                                                                                                                                                                                                                                                                              it('does not mutate the original error object', () => {
                                                                                                                                                                                                                                                                                  const err = new Error('do not mutate me');
                                                                                                                                                                                                                                                                                      const originalMessage = err.message;
                                                                                                                                                                                                                                                                                          sanitizeError(err);
                                                                                                                                                                                                                                                                                              expect(err.message).toBe(originalMessage);
                                                                                                                                                                                                                                                                                                });
                                                                                                                                                                                                                                                                                                });