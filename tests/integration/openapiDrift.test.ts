import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const ROOT = path.resolve(__dirname, '../..');
const specPath = path.join(ROOT, 'docs/openapi.yaml');
const driftScriptPath = path.join(ROOT, 'scripts/openapi-drift.js');

describe('OpenAPI Contract Drift', () => {
  it('docs/openapi.yaml exists and is non-empty', () => {
    expect(fs.existsSync(specPath)).toBe(true);
    const content = fs.readFileSync(specPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('paths:');
  });

  it('drift check script passes against the committed spec', () => {
    const result = execSync(`node ${driftScriptPath}`, { encoding: 'utf-8', stdio: 'pipe' });
    expect(result).toContain('No OpenAPI contract drift');
  });

  it('spec contains the snapshot endpoint', () => {
    const content = fs.readFileSync(specPath, 'utf-8');
    expect(content).toContain('/api/snapshot');
  });

  it('spec is in sync with the generator (re-gen produces no diff)', () => {
    // Run the generator and check that no changes occur to the committed file.
    execSync('npm run generate:openapi', { cwd: ROOT, stdio: 'pipe' });
    const result = execSync('git diff --exit-code docs/openapi.yaml', {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    // If git diff --exit-code returns 0, there is no diff; stdout will be empty.
    expect(result).toBe('');
  });
});
