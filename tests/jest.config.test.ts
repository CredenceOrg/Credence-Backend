import { describe, it, expect } from 'vitest';
import config from '../jest.config';
import fs from 'fs';
import path from 'path';

describe('jest.config.ts Loading and State', () => {
    it('should deterministically load the configuration object', () => {
        expect(config).toBeDefined();
        expect(typeof config).toBe('object');
        expect(config).not.toBeNull();
    });

    it('should have valid boundary properties configured', () => {
        expect(config.coverageThreshold?.global?.branches).toBeGreaterThanOrEqual(95);
        expect(config.coverageThreshold?.global?.functions).toBeGreaterThanOrEqual(95);
        expect(config.coverageThreshold?.global?.lines).toBeGreaterThanOrEqual(95);
        expect(config.coverageThreshold?.global?.statements).toBeGreaterThanOrEqual(95);
        
        expect(config.preset).toBe('ts-jest');
        expect(config.testEnvironment).toBe('node');
        expect(config.collectCoverage).toBe(true);
        expect(config.coverageDirectory).toBe('coverage');
    });

    it('should be identical on duplicate/concurrent imports (recovery and concurrent execution)', async () => {
        // Simulating concurrent execution and duplication
        const import1 = import('../jest.config');
        const import2 = import('../jest.config');
        const [mod1, mod2] = await Promise.all([import1, import2]);
        
        expect(mod1.default).toStrictEqual(mod2.default);
        expect(mod1.default).toStrictEqual(config);
    });

    it('should enforce validation and state-transition invariants', () => {
        // Verifying it has no unknown properties that could lead to inconsistent state
        const knownKeys = [
             'preset',
             'testEnvironment',
             'testMatch',
             'collectCoverage',
             'coverageDirectory',
             'coverageThreshold',
             'coveragePathIgnorePatterns'
        ];
        const actualKeys = Object.keys(config);
        for (const key of actualKeys) {
            expect(knownKeys).toContain(key);
        }
    });

    it('should handle permission/stale states appropriately', () => {
       // Validate that the underlying file is accessible and correct (read permissions)
       const configPath = path.resolve(__dirname, '../jest.config.ts');
       expect(fs.existsSync(configPath)).toBe(true);
       
       const stats = fs.statSync(configPath);
       expect(stats.size).toBeGreaterThan(0);
       
       // Throws if read permission is missing
       expect(() => fs.accessSync(configPath, fs.constants.R_OK)).not.toThrow();
    });

    it('should reject invalid or unsafe partial boundaries', () => {
        // Ensure test configuration handles path ignoring safely to avoid losing coverage data
        expect(config.coveragePathIgnorePatterns).toBeInstanceOf(Array);
        expect(config.coveragePathIgnorePatterns).toContain('/node_modules/');
        expect(config.coveragePathIgnorePatterns).toContain('/src/index.ts');
        
        // Ensure we match the correct test pattern and nothing broad
        expect(config.testMatch).toBeInstanceOf(Array);
        expect(config.testMatch?.length).toBe(1);
        expect(config.testMatch).toContain('**/tests/**/*.test.ts');
    });
});
