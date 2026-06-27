import { describe, expect, it } from "vitest";
import {
  SBOM_DIFF_COMMENT_MARKER,
  diffSbomComponents,
  renderSbomDiffMarkdown,
} from "../../scripts/sbom-component-diff.js";

describe("SBOM component diff", () => {
  it("reports added and removed components by stable component identity", () => {
    const baseBom = {
      components: [
        {
          type: "library",
          name: "kept",
          version: "1.0.0",
          purl: "pkg:npm/kept@1.0.0",
        },
        {
          type: "library",
          name: "removed",
          version: "1.0.0",
          purl: "pkg:npm/removed@1.0.0",
        },
      ],
    };
    const headBom = {
      components: [
        {
          type: "library",
          name: "kept",
          version: "1.0.0",
          purl: "pkg:npm/kept@1.0.0",
        },
        {
          type: "library",
          name: "added",
          version: "2.0.0",
          purl: "pkg:npm/added@2.0.0",
        },
      ],
    };

    const diff = diffSbomComponents(baseBom, headBom);

    expect(diff.added.map((component) => component.label)).toEqual(["added@2.0.0"]);
    expect(diff.removed.map((component) => component.label)).toEqual(["removed@1.0.0"]);
  });

  it("renders an updatable pull request comment body", () => {
    const markdown = renderSbomDiffMarkdown({
      added: [
        {
          key: "pkg:npm/added@2.0.0",
          label: "added@2.0.0",
          name: "added",
          version: "2.0.0",
          type: "library",
        },
      ],
      removed: [],
    });

    expect(markdown).toContain(SBOM_DIFF_COMMENT_MARKER);
    expect(markdown).toContain("| 1 | 0 |");
    expect(markdown).toContain("`added@2.0.0`");
    expect(markdown).toContain("_None_");
  });
});
