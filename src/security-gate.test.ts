import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import { 
  parseNpmAudit, 
  parseTrivy, 
  evaluateGate, 
  parseArgs, 
  readStdin, 
  SecurityIssue, 
  GateConfig 
} from '../scripts/security-gate';

// Set environment to test so main doesn't execute
process.env.NODE_ENV = 'test';

describe('Security Gate Logic', () => {

  describe('parseNpmAudit', () => {
    it('should return empty list on empty content', () => {
      expect(parseNpmAudit('')).toEqual([]);
      expect(parseNpmAudit('   ')).toEqual([]);
    });

    it('should return empty list if vulnerabilities key is missing', () => {
      const json = JSON.stringify({ auditReportVersion: 2 });
      expect(parseNpmAudit(json)).toEqual([]);
    });

    it('should correctly parse vulnerabilities in npm audit format', () => {
      const mockAudit = {
        auditReportVersion: 2,
        vulnerabilities: {
          'lodash': {
            name: 'lodash',
            severity: 'high',
            via: [
              {
                source: 1096727,
                name: 'lodash',
                dependency: 'lodash',
                title: 'Prototype Pollution in lodash',
                url: 'https://github.com/advisories/GHSA-m6fv-jmcg-4jfg',
                severity: 'high'
              }
            ],
            effects: [],
            range: '<4.17.21',
            nodes: ['node_modules/lodash'],
            fixAvailable: '4.17.21'
          },
          'minimist': {
            name: 'minimist',
            severity: 'moderate',
            via: 'GHSA-xvch-5gv4-98xp',
            effects: [],
            range: '<1.2.6',
            nodes: ['node_modules/minimist'],
            fixAvailable: true
          },
          'semver': {
            name: 'semver',
            severity: 'critical',
            via: {
              source: 'GHSA-c2qf-rxjj-qqgw',
              name: 'semver'
            },
            effects: [],
            range: '<7.5.2',
            nodes: ['node_modules/semver'],
            fixAvailable: false
          }
        }
      };

      const issues = parseNpmAudit(JSON.stringify(mockAudit));
      expect(issues).toHaveLength(3);

      const lodashIssue = issues.find(i => i.packageName === 'lodash');
      expect(lodashIssue).toBeDefined();
      expect(lodashIssue!.severity).toBe('high');
      expect(lodashIssue!.id).toContain('1096727');
      expect(lodashIssue!.id).toContain('Advisory:lodash');
      expect(lodashIssue!.fixedVersion).toBe('4.17.21');

      const minimistIssue = issues.find(i => i.packageName === 'minimist');
      expect(minimistIssue).toBeDefined();
      expect(minimistIssue!.severity).toBe('moderate');
      expect(minimistIssue!.id).toBe('GHSA-xvch-5gv4-98xp');
      expect(minimistIssue!.fixedVersion).toBe('Available');

      const semverIssue = issues.find(i => i.packageName === 'semver');
      expect(semverIssue).toBeDefined();
      expect(semverIssue!.severity).toBe('critical');
      expect(semverIssue!.id).toBe('GHSA-c2qf-rxjj-qqgw');
      expect(semverIssue!.fixedVersion).toBe('N/A');
    });

    it('should fallback to default Advisory ID if via information is missing', () => {
      const mockAudit = {
        auditReportVersion: 2,
        vulnerabilities: {
          'bad-package': {
            name: 'bad-package',
            severity: 'low',
            effects: [],
            fixAvailable: false
          }
        }
      };
      const issues = parseNpmAudit(JSON.stringify(mockAudit));
      expect(issues).toHaveLength(1);
      expect(issues[0].id).toBe('Advisory:bad-package');
    });
  });

  describe('parseTrivy', () => {
    it('should return empty list on empty content', () => {
      expect(parseTrivy('')).toEqual([]);
      expect(parseTrivy('   ')).toEqual([]);
    });

    it('should return empty list if Results key is missing or not an array', () => {
      expect(parseTrivy(JSON.stringify({}))).toEqual([]);
      expect(parseTrivy(JSON.stringify({ Results: 'not-an-array' }))).toEqual([]);
    });

    it('should correctly parse vulnerabilities in Trivy format', () => {
      const mockTrivy = {
        SchemaVersion: 2,
        Results: [
          {
            Target: 'package-lock.json',
            Class: 'lang-pkgs',
            Type: 'npm',
            Vulnerabilities: [
              {
                VulnerabilityID: 'CVE-2023-45133',
                PkgName: 'axios',
                InstalledVersion: '0.21.1',
                FixedVersion: '0.21.2',
                Severity: 'HIGH',
                Title: 'Server-Side Request Forgery in axios'
              },
              {
                VulnerabilityID: 'CVE-2023-30000',
                PkgName: 'express',
                InstalledVersion: '4.17.0',
                Severity: 'CRITICAL'
              }
            ]
          },
          {
            Target: 'Dockerfile',
            Class: 'os-pkgs',
          }
        ]
      };

      const issues = parseTrivy(JSON.stringify(mockTrivy));
      expect(issues).toHaveLength(2);

      const axiosIssue = issues.find(i => i.packageName === 'axios');
      expect(axiosIssue).toBeDefined();
      expect(axiosIssue!.severity).toBe('high');
      expect(axiosIssue!.id).toBe('CVE-2023-45133');
      expect(axiosIssue!.fixedVersion).toBe('0.21.2');
      expect(axiosIssue!.title).toBe('Server-Side Request Forgery in axios');

      const expressIssue = issues.find(i => i.packageName === 'express');
      expect(expressIssue).toBeDefined();
      expect(expressIssue!.severity).toBe('critical');
      expect(expressIssue!.id).toBe('CVE-2023-30000');
      expect(expressIssue!.fixedVersion).toBe('N/A');
    });
  });

  describe('evaluateGate', () => {
    const issues: SecurityIssue[] = [
      { packageName: 'pkg-low', severity: 'low', id: 'CVE-1' },
      { packageName: 'pkg-medium', severity: 'medium', id: 'CVE-2' },
      { packageName: 'pkg-high', severity: 'high', id: 'CVE-3' },
      { packageName: 'pkg-critical', severity: 'critical', id: 'CVE-4' }
    ];

    it('should enforce threshold correctly', () => {
      const config1: GateConfig = { threshold: 'critical', ignorePkgs: [], ignoreCves: [] };
      const res1 = evaluateGate(issues, config1);
      expect(res1.passed).toBe(false);
      expect(res1.violatingIssues).toHaveLength(1);
      expect(res1.violatingIssues[0].packageName).toBe('pkg-critical');

      const config2: GateConfig = { threshold: 'high', ignorePkgs: [], ignoreCves: [] };
      const res2 = evaluateGate(issues, config2);
      expect(res2.passed).toBe(false);
      expect(res2.violatingIssues).toHaveLength(2);

      const config3: GateConfig = { threshold: 'moderate', ignorePkgs: [], ignoreCves: [] };
      const res3 = evaluateGate(issues, config3);
      expect(res3.passed).toBe(false);
      expect(res3.violatingIssues).toHaveLength(3);
    });

    it('should ignore packages in the allowlist', () => {
      const config: GateConfig = { 
        threshold: 'high', 
        ignorePkgs: ['pkg-high', 'pkg-critical'], 
        ignoreCves: [] 
      };
      const res = evaluateGate(issues, config);
      expect(res.passed).toBe(true);
      expect(res.violatingIssues).toHaveLength(0);
    });

    it('should ignore CVEs in the allowlist', () => {
      const config: GateConfig = { 
        threshold: 'high', 
        ignorePkgs: [], 
        ignoreCves: ['CVE-3', 'CVE-4'] 
      };
      const res = evaluateGate(issues, config);
      expect(res.passed).toBe(true);
      expect(res.violatingIssues).toHaveLength(0);
    });

    it('should handle comma-separated list of CVE IDs in issue and match ignores', () => {
      const multiIdIssues: SecurityIssue[] = [
        { packageName: 'some-pkg', severity: 'high', id: 'CVE-100, CVE-200' }
      ];
      const config: GateConfig = { 
        threshold: 'high', 
        ignorePkgs: [], 
        ignoreCves: ['CVE-200'] 
      };
      const res = evaluateGate(multiIdIssues, config);
      expect(res.passed).toBe(true);
    });
  });

  describe('parseArgs', () => {
    it('should parse simple flags correctly', () => {
      const argv = ['--file', 'audit.json', '--threshold', 'critical', '--format', 'trivy'];
      const parsed = parseArgs(argv);
      expect(parsed.file).toBe('audit.json');
      expect(parsed.threshold).toBe('critical');
      expect(parsed.format).toBe('trivy');
    });

    it('should parse equals-style flags correctly', () => {
      const argv = ['--file=audit.json', '--threshold=critical', '--format=trivy'];
      const parsed = parseArgs(argv);
      expect(parsed.file).toBe('audit.json');
      expect(parsed.threshold).toBe('critical');
      expect(parsed.format).toBe('trivy');
    });

    it('should parse short flags correctly', () => {
      const argv = ['-f', 'audit.json', '-t', 'low'];
      const parsed = parseArgs(argv);
      expect(parsed.file).toBe('audit.json');
      expect(parsed.threshold).toBe('low');
    });

    it('should parse ignore packages and CVE lists', () => {
      const argv = [
        '--ignore-pkg', 'lodash,axios', 
        '--ignore-cve', 'CVE-1,CVE-2'
      ];
      const parsed = parseArgs(argv);
      expect(parsed.ignorePkgs).toEqual(['lodash', 'axios']);
      expect(parsed.ignoreCves).toEqual(['CVE-1', 'CVE-2']);
    });

    it('should parse ignore packages and CVE lists in equals-style', () => {
      const argv = [
        '--ignore-pkg=lodash,axios', 
        '--ignore-cve=CVE-1,CVE-2'
      ];
      const parsed = parseArgs(argv);
      expect(parsed.ignorePkgs).toEqual(['lodash', 'axios']);
      expect(parsed.ignoreCves).toEqual(['CVE-1', 'CVE-2']);
    });
  });

  describe('readStdin', () => {
    it('should resolve with empty string when isTTY is true', async () => {
      const originalIsTTY = process.stdin.isTTY;
      process.stdin.isTTY = true;
      
      const content = await readStdin();
      expect(content).toBe('');
      
      process.stdin.isTTY = originalIsTTY;
    });

    it('should read data from standard input streams', async () => {
      const originalIsTTY = process.stdin.isTTY;
      process.stdin.isTTY = false;
      
      const mockStdin = {
        setEncoding: vi.fn(),
        on: vi.fn((event, callback) => {
          if (event === 'data') {
            setTimeout(() => callback('chunk1\nchunk2'), 5);
          }
          if (event === 'end') {
            setTimeout(() => callback(), 10);
          }
          return mockStdin;
        })
      };
      
      const spyStdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(mockStdin as any);
      
      const content = await readStdin();
      expect(content).toBe('chunk1\nchunk2');
      
      spyStdin.mockRestore();
      process.stdin.isTTY = originalIsTTY;
    });
  });
});
