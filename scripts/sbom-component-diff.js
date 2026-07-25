#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const SBOM_DIFF_COMMENT_MARKER = "<!-- credence-sbom-component-diff -->";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function componentKey(component) {
  if (component.purl) {
    return component.purl;
  }

  const group = component.group ? `${component.group}/` : "";
  const version = component.version ? `@${component.version}` : "";
  return `${component.type ?? "component"}:${group}${component.name}${version}`;
}

function componentLabel(component) {
  const group = component.group ? `${component.group}/` : "";
  const version = component.version ? `@${component.version}` : "";
  return `${group}${component.name}${version}`;
}

function indexComponents(bom) {
  const components = Array.isArray(bom?.components) ? bom.components : [];
  return new Map(
    components
      .filter((component) => component && component.name)
      .map((component) => [
        componentKey(component),
        {
          key: componentKey(component),
          label: componentLabel(component),
          name: component.name,
          version: component.version ?? "",
          type: component.type ?? "library",
        },
      ]),
  );
}

export function diffSbomComponents(baseBom, headBom) {
  const baseComponents = indexComponents(baseBom);
  const headComponents = indexComponents(headBom);

  const added = [];
  const removed = [];

  for (const [key, component] of headComponents) {
    if (!baseComponents.has(key)) {
      added.push(component);
    }
  }

  for (const [key, component] of baseComponents) {
    if (!headComponents.has(key)) {
      removed.push(component);
    }
  }

  const byLabel = (left, right) => left.label.localeCompare(right.label);
  return {
    added: added.sort(byLabel),
    removed: removed.sort(byLabel),
  };
}

function renderList(components) {
  if (components.length === 0) {
    return "_None_";
  }

  return components
    .map((component) => `- \`${component.label}\` (${component.type})`)
    .join("\n");
}

export function renderSbomDiffMarkdown(diff) {
  return `${SBOM_DIFF_COMMENT_MARKER}
## SBOM component changes

| Added | Removed |
| ---: | ---: |
| ${diff.added.length} | ${diff.removed.length} |

### Added components
${renderList(diff.added)}

### Removed components
${renderList(diff.removed)}
`;
}

function parseArgs(argv) {
  const args = {
    base: undefined,
    head: undefined,
    markdown: undefined,
    summary: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--summary") {
      args.summary = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      args[key] = argv[index + 1];
      index += 1;
    }
  }

  if (!args.base || !args.head) {
    throw new Error("Usage: sbom-component-diff --base <base-sbom.json> --head <head-sbom.json> [--markdown <out.md>] [--summary]");
  }

  return args;
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const diff = diffSbomComponents(readJson(args.base), readJson(args.head));
  const markdown = renderSbomDiffMarkdown(diff);

  if (args.markdown) {
    writeFileSync(args.markdown, markdown);
  } else {
    process.stdout.write(markdown);
  }

  if (args.summary && process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runCli();
  } catch (error) {
    console.error(`${basename(process.argv[1])}: ${error.message}`);
    process.exit(1);
  }
}
