#!/usr/bin/env node
/**
 * OpenAPI Contract Drift Detector (pure Node.js - no external deps)
 *
 * All pure functions are exported so they can be unit-tested in isolation
 * without spawning a child process. The `main()` function is also exported
 * for integration-level tests that want to exercise the full orchestration
 * path. The module still auto-runs `main()` when executed directly so the
 * CLI contract is unchanged.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function isAdminRoute(p) {
  return p.startsWith('/api/admin');
}

export function getRegisteredRoutes() {
  // Keep in sync with paths registered in scripts/generate-openapi.ts
  const routes = [
    { path: '/.well-known/jwks.json', method: 'get' },
    { path: '/api/health', method: 'get' },
    { path: '/api/trust/:address', method: 'get' },
    { path: '/api/trust', method: 'post' },
    { path: '/api/attestations/:address', method: 'get' },
    { path: '/api/attestations', method: 'post' },
    { path: '/api/bulk', method: 'post' },
    { path: '/api/imports', method: 'post' },
    { path: '/api/orgs/:orgId/policies', method: 'get' },
    { path: '/api/analytics', method: 'get' },
    { path: '/api/payouts', method: 'post' },
    { path: '/api/bond/:address', method: 'get' },
    { path: '/api/bond', method: 'post' },
    { path: '/api/governance/slash-requests', method: 'post' },
    { path: '/api/governance/slash-requests', method: 'get' },
    { path: '/api/governance/slash-requests/:id', method: 'get' },
    { path: '/api/governance/slash-requests/:id/votes', method: 'post' },
    { path: '/api/disputes', method: 'post' },
    { path: '/api/disputes/:id', method: 'get' },
    { path: '/api/disputes/:id/review', method: 'post' },
    { path: '/api/disputes/:id/resolve', method: 'post' },
    { path: '/api/disputes/:id/dismiss', method: 'post' },
    { path: '/api/version', method: 'get' },
    { path: '/api/wallets', method: 'post' },
    { path: '/api/wallets/:id/debit', method: 'post' },
    { path: '/api/dev/fault-injection', method: 'post' },
  ];
  return routes.filter(r => !isAdminRoute(r.path));
}

export function normalizePath(p) {
  return p.replace(/\{([^}]+)\}/g, ':$1');
}

export function parsePathsFromYaml(yamlContent) {
  const paths = {};
  const lines = yamlContent.split('\n');
  let inPaths = false;
  let currentPath = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'paths:') {
      inPaths = true;
      continue;
    }
    if (inPaths && trimmed.startsWith('/') && trimmed.endsWith(':')) {
      currentPath = normalizePath(trimmed.slice(0, -1));
      paths[currentPath] = {};
    } else if (inPaths && currentPath && (trimmed.startsWith('get:') || trimmed.startsWith('post:') || trimmed.startsWith('put:') || trimmed.startsWith('delete:') || trimmed.startsWith('patch:'))) {
      const method = trimmed.split(':')[0].toLowerCase();
      if (currentPath) {
        paths[currentPath][method] = {};
      }
    }
  }
  return paths;
}

export function loadOpenApiPaths() {
  const specPath = path.join(ROOT, 'docs/openapi.yaml');
  const content = fs.readFileSync(specPath, 'utf-8');
  return parsePathsFromYaml(content);
}

export function detectDrift(routes, specPaths) {
  const errors = [];

  for (const route of routes) {
    if (!specPaths[route.path] || !specPaths[route.path][route.method]) {
      errors.push(`Missing route in OpenAPI: ${route.method.toUpperCase()} ${route.path}`);
    }
  }

  for (const p of Object.keys(specPaths)) {
    if (isAdminRoute(p)) continue;
    for (const m of Object.keys(specPaths[p])) {
      const exists = routes.some(r => r.path === p && r.method === m);
      if (!exists) {
        errors.push(`Extra route in OpenAPI (not in code): ${m.toUpperCase()} ${p}`);
      }
    }
  }

  if (Object.keys(specPaths).length === 0) {
    errors.push('OpenAPI spec appears empty or invalid');
  }

  return errors;
}

export function main() {
  const routes = getRegisteredRoutes();
  const specPaths = loadOpenApiPaths();
  const drift = detectDrift(routes, specPaths);

  if (drift.length > 0) {
    console.error('❌ OpenAPI contract drift detected:');
    drift.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }

  console.log('✅ No OpenAPI contract drift detected. All routes match spec.');
  process.exit(0);
}

// Auto-run when executed directly (node scripts/openapi-drift.js).
// Skipped when imported as a module by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}