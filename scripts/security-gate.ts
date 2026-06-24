import * as fs from 'fs';
import * as path from 'path';

export interface SecurityIssue {
  packageName: string;
  severity: string;
  id: string; // CVE or advisory ID
  title?: string;
  fixedVersion?: string;
}

export interface GateConfig {
  threshold: 'low' | 'moderate' | 'medium' | 'high' | 'critical';
  ignorePkgs: string[];
  ignoreCves: string[];
}

export const SEVERITY_RANKS: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  moderate: 2, // Map npm's moderate to medium
  high: 3,
  critical: 4
};

export function parseNpmAudit(jsonContent: string): SecurityIssue[] {
  if (!jsonContent.trim()) return [];
  
  const report = JSON.parse(jsonContent);
  const issues: SecurityIssue[] = [];
  
  if (!report.vulnerabilities) {
    return issues;
  }
  
  for (const [pkgName, vuln] of Object.entries(report.vulnerabilities)) {
    const v = vuln as any;
    const severity = (v.severity || 'low').toLowerCase();
    
    // Extract CVEs or IDs from via
    let ids: string[] = [];
    if (v.via && Array.isArray(v.via)) {
      v.via.forEach((item: any) => {
        if (typeof item === 'object') {
          if (item.source) ids.push(String(item.source));
          if (item.name) ids.push(`Advisory:${item.name}`);
        } else if (item) {
          ids.push(String(item));
        }
      });
    } else if (v.via && typeof v.via === 'object') {
      if (v.via.source) ids.push(String(v.via.source));
    } else if (v.via) {
      ids.push(String(v.via));
    }
    
    if (ids.length === 0) {
      ids.push(`Advisory:${pkgName}`);
    }
    
    issues.push({
      packageName: pkgName,
      severity,
      id: ids.join(', '),
      title: v.name || pkgName,
      fixedVersion: typeof v.fixAvailable === 'string' 
        ? v.fixAvailable 
        : (v.fixAvailable ? 'Available' : 'N/A')
    });
  }
  
  return issues;
}

export function parseTrivy(jsonContent: string): SecurityIssue[] {
  if (!jsonContent.trim()) return [];
  
  const report = JSON.parse(jsonContent);
  const issues: SecurityIssue[] = [];
  
  if (!report.Results || !Array.isArray(report.Results)) {
    return issues;
  }
  
  for (const result of report.Results) {
    if (!result.Vulnerabilities || !Array.isArray(result.Vulnerabilities)) {
      continue;
    }
    
    for (const vuln of result.Vulnerabilities) {
      issues.push({
        packageName: vuln.PkgName || 'unknown',
        severity: (vuln.Severity || 'low').toLowerCase(),
        id: vuln.VulnerabilityID || 'N/A',
        title: vuln.Title || vuln.Description || 'N/A',
        fixedVersion: vuln.FixedVersion || 'N/A'
      });
    }
  }
  
  return issues;
}

export function evaluateGate(
  issues: SecurityIssue[],
  config: GateConfig
): { passed: boolean; violatingIssues: SecurityIssue[] } {
  const thresholdRank = SEVERITY_RANKS[config.threshold] ?? 3; // Default to high
  const violatingIssues: SecurityIssue[] = [];
  
  for (const issue of issues) {
    const sev = issue.severity.toLowerCase();
    const rank = SEVERITY_RANKS[sev] ?? 1;
    
    // Check if ignored by package name
    if (config.ignorePkgs.includes(issue.packageName)) {
      continue;
    }
    
    // Check if ignored by CVE ID
    const cves = issue.id.split(', ').map(id => id.trim());
    const isCveIgnored = cves.some(cve => config.ignoreCves.includes(cve));
    if (isCveIgnored) {
      continue;
    }
    
    if (rank >= thresholdRank) {
      violatingIssues.push(issue);
    }
  }
  
  return {
    passed: violatingIssues.length === 0,
    violatingIssues
  };
}

export function parseArgs(argv: string[]) {
  const args = {
    file: '',
    threshold: 'high' as GateConfig['threshold'],
    ignorePkgs: [] as string[],
    ignoreCves: [] as string[],
    format: 'auto' as 'auto' | 'npm-audit' | 'trivy'
  };
  
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '-f') {
      args.file = argv[++i] || '';
    } else if (arg.startsWith('--file=')) {
      args.file = arg.substring(7);
    } else if (arg === '--threshold' || arg === '-t') {
      const val = (argv[++i] || 'high').toLowerCase() as any;
      args.threshold = val;
    } else if (arg.startsWith('--threshold=')) {
      args.threshold = arg.substring(12).toLowerCase() as any;
    } else if (arg === '--ignore-pkg') {
      const val = argv[++i] || '';
      args.ignorePkgs = val.split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--ignore-pkg=')) {
      args.ignorePkgs = arg.substring(13).split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--ignore-cve') {
      const val = argv[++i] || '';
      args.ignoreCves = val.split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--ignore-cve=')) {
      args.ignoreCves = arg.substring(13).split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--format') {
      args.format = (argv[++i] || 'auto') as any;
    } else if (arg.startsWith('--format=')) {
      args.format = arg.substring(9) as any;
    }
  }
  
  return args;
}

export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      return resolve('');
    }
    
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  
  let jsonContent = '';
  if (args.file) {
    const fullPath = path.resolve(args.file);
    if (!fs.existsSync(fullPath)) {
      console.error(`Error: File not found: ${args.file}`);
      process.exit(1);
    }
    jsonContent = fs.readFileSync(fullPath, 'utf8');
  } else {
    jsonContent = await readStdin();
    if (!jsonContent.trim()) {
      console.error('Error: No input file specified and no data piped on stdin.');
      console.error('Usage: node security-gate.js --file <report.json> --threshold <high|critical>');
      console.error('   or: npm audit --json | node security-gate.js --threshold high');
      process.exit(1);
    }
  }
  
  let detectedFormat = args.format;
  if (detectedFormat === 'auto') {
    try {
      const parsed = JSON.parse(jsonContent);
      if (parsed.auditReportVersion !== undefined || parsed.vulnerabilities !== undefined) {
        detectedFormat = 'npm-audit';
      } else if (parsed.SchemaVersion !== undefined || parsed.Results !== undefined) {
        detectedFormat = 'trivy';
      } else {
        console.error('Error: Could not auto-detect report format. Please specify --format=npm-audit or --format=trivy.');
        process.exit(1);
      }
    } catch (e: any) {
      console.error(`Error parsing JSON content: ${e.message}`);
      process.exit(1);
    }
  }
  
  let issues: SecurityIssue[] = [];
  try {
    if (detectedFormat === 'npm-audit') {
      issues = parseNpmAudit(jsonContent);
    } else if (detectedFormat === 'trivy') {
      issues = parseTrivy(jsonContent);
    }
  } catch (e: any) {
    console.error(`Error decoding report content: ${e.message}`);
    process.exit(1);
  }
  
  const gateConfig: GateConfig = {
    threshold: args.threshold,
    ignorePkgs: args.ignorePkgs,
    ignoreCves: args.ignoreCves
  };
  
  console.log(`[Security Gate] Evaluating ${issues.length} vulnerability findings...`);
  console.log(`[Security Gate] Policy: Fail on ${gateConfig.threshold.toUpperCase()} or higher severity.`);
  if (gateConfig.ignorePkgs.length > 0) {
    console.log(`[Security Gate] Ignoring packages: ${gateConfig.ignorePkgs.join(', ')}`);
  }
  if (gateConfig.ignoreCves.length > 0) {
    console.log(`[Security Gate] Ignoring CVEs/Advisories: ${gateConfig.ignoreCves.join(', ')}`);
  }
  
  const result = evaluateGate(issues, gateConfig);
  
  if (!result.passed) {
    console.error(`\n[Security Gate] ❌ FAILED: Found ${result.violatingIssues.length} policy-violating vulnerabilities!`);
    console.error('--------------------------------------------------');
    result.violatingIssues.forEach(issue => {
      console.error(`Package:  ${issue.packageName}`);
      console.error(`Severity: ${issue.severity.toUpperCase()}`);
      console.error(`ID(s):    ${issue.id}`);
      console.error(`Title:    ${issue.title}`);
      console.error(`Fix:      ${issue.fixedVersion}`);
      console.error('--------------------------------------------------');
    });
    process.exit(1);
  }
  
  console.log('\n[Security Gate] ✅ PASSED: No policy-violating vulnerabilities found.');
  process.exit(0);
}

// Auto-run unless imported in tests
if (process.env.NODE_ENV !== 'test') {
  main().catch(err => {
    console.error('Unhandled security gate exception:', err);
    process.exit(1);
  });
}
