#!/usr/bin/env node
/**
 * OpenAPI Contract Drift Detector (pure Node.js - no external deps)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function isAdminRoute(p) {
  return p.startsWith('/api/admin');
}

function getRegisteredRoutes() {
  // Keep in sync with paths registered in scripts/generate-openapi.ts
  const routes = [
    { path: '/api/bond/:address', method: 'get' },
    { path: '/api/bond', method: 'post' },
  ];
  return routes.filter(r => !isAdminRoute(r.path));
}

function normalizePath(p) {
  return p.replace(/\{([^}]+)\}/g, ':$1');
}

function parsePathsFromYaml(yamlContent) {
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

function loadOpenApiPaths() {
  const specPath = path.join(ROOT, 'docs/openapi.yaml');
  const content = fs.readFileSync(specPath, 'utf-8');
  return parsePathsFromYaml(content);
}

function detectDrift(routes, specPaths) {
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

function main() {
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

main();