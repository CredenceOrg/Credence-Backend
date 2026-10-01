import { diffSbomComponents, renderSbomDiffMarkdown, runCli } from "./sbom-component-diff.js";
import { readFileSync, writeFileSync } from "node:fs";

jest.mock("node:fs", () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

describe("sbom-component-diff", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe("diffSbomComponents", () => {
    it("should return empty added and removed when both are empty", () => {
      const baseBom = { components: [] };
      const headBom = { components: [] };
      const diff = diffSbomComponents(baseBom, headBom);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
    });

    it("should handle boundary case where components is missing or not an array", () => {
      const baseBom = {};
      const headBom = { components: null };
      const diff = diffSbomComponents(baseBom, headBom);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
    });

    it("should compute added and removed correctly with purls", () => {
      const baseBom = { components: [{ purl: "pkg:npm/a@1.0.0", name: "a", version: "1.0.0" }] };
      const headBom = { components: [{ purl: "pkg:npm/b@2.0.0", name: "b", version: "2.0.0" }] };
      const diff = diffSbomComponents(baseBom, headBom);
      
      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0].name).toBe("a");
      expect(diff.added).toHaveLength(1);
      expect(diff.added[0].name).toBe("b");
    });

    it("should fallback to group/name/version when purl is missing", () => {
      const baseBom = { components: [{ group: "org", name: "a", version: "1.0.0", type: "library" }] };
      const headBom = { components: [{ name: "b", version: "2.0.0" }] }; // no group
      const diff = diffSbomComponents(baseBom, headBom);
      
      expect(diff.removed[0].key).toBe("library:org/a@1.0.0");
      expect(diff.added[0].key).toBe("component:b@2.0.0");
    });
  });

  describe("renderSbomDiffMarkdown", () => {
    it("should render correctly with empty diffs", () => {
      const diff = { added: [], removed: [] };
      const md = renderSbomDiffMarkdown(diff);
      expect(md).toContain("_None_");
      expect(md).toContain("| 0 | 0 |");
    });

    it("should render added and removed items", () => {
      const diff = {
        added: [{ label: "org/a@1.0.0", type: "library" }],
        removed: [{ label: "b@2.0.0", type: "framework" }]
      };
      const md = renderSbomDiffMarkdown(diff);
      expect(md).toContain("- `org/a@1.0.0` (library)");
      expect(md).toContain("- `b@2.0.0` (framework)");
      expect(md).toContain("| 1 | 1 |");
    });
  });

  describe("runCli", () => {
    const originalStdoutWrite = process.stdout.write;
    const originalEnv = process.env;

    beforeEach(() => {
      process.stdout.write = jest.fn();
      process.env = { ...originalEnv };
      delete process.env.GITHUB_STEP_SUMMARY;
    });

    afterEach(() => {
      process.stdout.write = originalStdoutWrite;
      process.env = originalEnv;
    });

    it("should throw if missing arguments", () => {
      expect(() => runCli(["--base", "base.json"])).toThrow(/Usage:/);
    });

    it("should throw error when reading file fails (e.g. permission or not found)", () => {
      readFileSync.mockImplementation(() => {
        throw new Error("EACCES: permission denied, open 'base.json'");
      });
      expect(() => runCli(["--base", "base.json", "--head", "head.json"])).toThrow(/EACCES/);
    });

    it("should throw error for malformed json (recovery/stale state handling)", () => {
      readFileSync.mockReturnValue("invalid json");
      expect(() => runCli(["--base", "base.json", "--head", "head.json"])).toThrow(SyntaxError);
    });

    it("should output to markdown file when --markdown is provided", () => {
      readFileSync.mockReturnValue(JSON.stringify({ components: [] }));
      runCli(["--base", "base.json", "--head", "head.json", "--markdown", "out.md"]);
      expect(writeFileSync).toHaveBeenCalledWith("out.md", expect.any(String));
      expect(process.stdout.write).not.toHaveBeenCalled();
    });

    it("should write to stdout when no markdown file provided", () => {
      readFileSync.mockReturnValue(JSON.stringify({ components: [] }));
      runCli(["--base", "base.json", "--head", "head.json"]);
      expect(process.stdout.write).toHaveBeenCalledWith(expect.any(String));
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it("should append to GITHUB_STEP_SUMMARY when --summary is passed", () => {
      process.env.GITHUB_STEP_SUMMARY = "summary.md";
      readFileSync.mockReturnValue(JSON.stringify({ components: [] }));
      runCli(["--base", "base.json", "--head", "head.json", "--summary"]);
      expect(writeFileSync).toHaveBeenCalledWith("summary.md", expect.any(String), { flag: "a" });
    });
  });
});
