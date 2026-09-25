import { afterEach, describe, expect, it } from "vitest";
import { discoverWorkspaces } from "../src/repository";
import { byRule, check, cleanupRepos, makeRepo } from "./helpers";

afterEach(cleanupRepos);

const pkg = (name: string, scripts: Record<string, string> = {}, extra: object = {}) => JSON.stringify({ name, scripts, ...extra });

const monorepo = (readme: string, extra: Record<string, string> = {}) => ({
  "README.md": readme,
  "package.json": pkg("root", { lint: "x" }, { workspaces: ["packages/*", "apps/**"], packageManager: "pnpm@10.0.0" }),
  "packages/web/package.json": pkg("@acme/web", { build: "vite build", dev: "vite" }),
  "packages/api/package.json": pkg("api", { start: "node ." }),
  "apps/site/docs/package.json": pkg("docs-site", { build: "x" }),
  ...extra,
});

describe("workspace discovery", () => {
  it("reads package.json workspaces (array and object form) and pnpm-workspace.yaml", async () => {
    const files = {
      "packages/a/package.json": pkg("a"),
      "packages/b/package.json": pkg("b"),
      "tools/c/package.json": pkg("c"),
      "packages/not-a-package/readme.txt": "",
    };
    const root = await makeRepo(files);
    expect((await discoverWorkspaces(root, ["packages/*"])).map((w) => w.name)).toEqual(["a", "b"]);
    expect((await discoverWorkspaces(root, ["packages/*", "tools/*"])).map((w) => w.dir)).toEqual(["packages/a", "packages/b", "tools/c"]);
  });

  it("supports ** and !exclusions and never enters node_modules", async () => {
    const root = await makeRepo({
      "apps/x/package.json": pkg("x"),
      "apps/x/nested/package.json": pkg("nested"),
      "apps/legacy/package.json": pkg("legacy"),
      "apps/node_modules/dep/package.json": pkg("dep"),
    });
    const found = await discoverWorkspaces(root, ["apps/**", "!apps/legacy"]);
    expect(found.map((w) => w.dir)).toEqual(["apps/x", "apps/x/nested"]);
  });

  it("is exposed on the repository facts from both sources", async () => {
    const report = await check({
      "README.md": "x",
      "package.json": JSON.stringify({ workspaces: { packages: ["libs/*"] } }),
      "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "libs/a/package.json": pkg("liba"),
      "apps/b/package.json": pkg("appb"),
    });
    expect(report.findings).toEqual([]);
  });
});

describe("scoped script commands", () => {
  it("accepts scripts defined in the targeted workspace", async () => {
    const report = await check(
      monorepo("```bash\npnpm --filter @acme/web build\npnpm --filter=api start\nnpm run build --workspace=packages/web\nyarn workspace @acme/web dev\n```"),
    );
    expect(byRule(report.findings, "package-scripts")).toEqual([]);
  });

  it("reports a script missing from the targeted workspace, naming that package.json", async () => {
    const report = await check(monorepo("```bash\npnpm --filter api build\n```"));
    expect(byRule(report.findings, "package-scripts")).toMatchObject([
      {
        severity: "error",
        line: 2,
        message: 'README.md references package script "build", but packages/api/package.json does not define it.',
        details: expectDetails("packages/api/package.json", "start"),
      },
    ]);
  });

  it("reports a workspace that does not exist and suggests the closest one", async () => {
    const report = await check(monorepo("```bash\npnpm --filter @acme/wbe build\n```"));
    const [finding] = byRule(report.findings, "package-scripts");
    expect(finding?.message).toBe('README.md references workspace "@acme/wbe", but no such workspace exists.');
    expect(finding?.suggestion).toBe('Did you mean the workspace "@acme/web"?');
  });

  it("does not report unknown workspaces in a repository without workspaces", async () => {
    const report = await check({ "README.md": "```bash\npnpm --filter web build\n```", "package.json": pkg("x") });
    expect(byRule(report.findings, "package-scripts")).toEqual([]);
  });

  it("skips filters it cannot resolve statically", async () => {
    const report = await check(monorepo("```bash\npnpm --filter './packages/*' build\npnpm --filter ...web build\npnpm --filter '!api' deploy\n```"));
    expect(byRule(report.findings, "package-scripts")).toEqual([]);
  });

  it("checks -r and --workspaces against every package, root included", async () => {
    const ok = await check(monorepo("```bash\npnpm -r run build\nnpm run lint --workspaces\n```"));
    expect(byRule(ok.findings, "package-scripts")).toEqual([]);
    const bad = await check(monorepo("```bash\npnpm -r run deploy\n```"));
    expect(byRule(bad.findings, "package-scripts")[0]?.message).toBe('README.md references package script "deploy", but no workspace package defines it.');
  });

  it("resolves commands after cd against that package", async () => {
    const ok = await check(monorepo("```bash\ncd packages/web\npnpm build\n```"));
    expect(byRule(ok.findings, "package-scripts")).toEqual([]);
    const bad = await check(monorepo("```bash\ncd packages/web && pnpm start\n```"));
    expect(byRule(bad.findings, "package-scripts")[0]?.message).toContain("packages/web/package.json does not define it");
  });

  it("resolves --prefix and --dir, and skips directories without a package.json", async () => {
    const bad = await check(monorepo("```bash\nnpm --prefix packages/api run build\n```"));
    expect(byRule(bad.findings, "package-scripts")).toHaveLength(1);
    const ok = await check(monorepo("```bash\npnpm --dir packages/web build\ncd examples/demo\nnpm run whatever\n```"));
    expect(byRule(ok.findings, "package-scripts")).toEqual([]);
  });

  it("resolves node file commands relative to the directory after cd", async () => {
    const report = await check({
      "README.md": "```bash\ncd server\nnode index.js\nnode missing.js\n```",
      "server/index.js": "",
    });
    expect(byRule(report.findings, "commands").map((f) => f.subject)).toEqual(["server/missing.js"]);
  });
});

function expectDetails(pkgFile: string, defined: string): string {
  return `Command: pnpm --filter api build. Scripts defined in ${pkgFile}: ${defined}.`;
}
