import { afterEach, describe, expect, it } from "vitest";
import { classifyPackageCommand } from "../src/checks/packages";
import { byRule, check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

const pkg = (extra: object = {}) => JSON.stringify({ name: "x", scripts: { build: "tsc", test: "vitest", dev: "vite" }, ...extra });

describe("classifyPackageCommand", () => {
  const c = (line: string) => classifyPackageCommand(line.split(" "));

  it("recognizes project installs but not package installs or global installs", () => {
    expect(c("npm install")).toEqual({ manager: "npm", kind: "install" });
    expect(c("npm ci")).toEqual({ manager: "npm", kind: "install" });
    expect(c("pnpm i")).toEqual({ manager: "pnpm", kind: "install" });
    expect(c("yarn")).toEqual({ manager: "yarn", kind: "install" });
    expect(c("bun install")).toEqual({ manager: "bun", kind: "install" });
    expect(c("npm install some-package")).toBeUndefined();
    expect(c("npm install -g doceye")).toBeUndefined();
    expect(c("pnpm add -D vitest")).toBeUndefined();
    expect(c("yarn add left-pad")).toBeUndefined();
  });

  it("recognizes script runners and shorthands", () => {
    expect(c("npm run build")).toMatchObject({ kind: "script", script: "build" });
    expect(c("npm run build -- --watch")).toMatchObject({ script: "build" });
    expect(c("npm test")).toMatchObject({ script: "test" });
    expect(c("pnpm run deploy")).toMatchObject({ script: "deploy", shorthand: false });
    expect(c("pnpm build")).toMatchObject({ script: "build", shorthand: true });
    expect(c("yarn build")).toMatchObject({ script: "build" });
    expect(c("bun run build")).toMatchObject({ script: "build" });
  });

  it("does not treat built-in subcommands as scripts", () => {
    for (const line of ["pnpm dlx create-x", "pnpm exec tsc", "pnpm add x", "yarn add x", "yarn workspaces list", "bun test", "bun x foo", "npm publish", "npm pack", "npx foo"]) {
      expect(c(line)).toBeUndefined();
    }
  });

  it("skips dynamic, unresolvable and file-running commands", () => {
    const skipped = [
      "npm run build:$ENV", "bun run index.ts", "npm run", "npm run build --if-present", "pnpm --filter ./apps/* build",
      "pnpm --filter ...web build", "pnpm --filter !web build", "npm run build -w", "yarn workspace build",
    ];
    for (const line of skipped) expect(c(line)).toBeUndefined();
  });

  it("recognizes where scoped commands apply", () => {
    expect(c("pnpm --filter web build")).toMatchObject({ script: "build", scope: { kind: "workspace", selector: "web" } });
    expect(c("pnpm -F @acme/web run build")).toMatchObject({ scope: { kind: "workspace", selector: "@acme/web" } });
    expect(c("npm run build --workspace=packages/a")).toMatchObject({ scope: { kind: "workspace", selector: "packages/a" } });
    expect(c("npm run build -w a")).toMatchObject({ scope: { kind: "workspace", selector: "a" } });
    expect(c("npm run build --workspaces")).toMatchObject({ scope: { kind: "all" } });
    expect(c("pnpm -r run build")).toMatchObject({ scope: { kind: "all" } });
    expect(c("yarn workspace web build")).toMatchObject({ script: "build", scope: { kind: "workspace", selector: "web" } });
    expect(c("yarn workspace web run build")).toMatchObject({ script: "build", scope: { kind: "workspace", selector: "web" } });
    expect(c("npm --prefix web run build")).toMatchObject({ scope: { kind: "dir", path: "web" } });
    expect(c("pnpm --dir apps/site build")).toMatchObject({ scope: { kind: "dir", path: "apps/site" } });
    expect(c("bun --filter web run build")).toMatchObject({ scope: { kind: "workspace", selector: "web" } });
  });
});

describe("package manager rule", () => {
  it("warns when the README uses npm but the repository indicates pnpm", async () => {
    const report = await check({
      "README.md": "# X\n\n```bash\nnpm install\nnpm run build\n```\n",
      "package.json": pkg({ packageManager: "pnpm@10.0.0" }),
      "pnpm-lock.yaml": "",
    });
    const findings = byRule(report.findings, "package-manager");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "warning",
      file: "README.md",
      line: 4,
      message: 'README.md uses npm ("npm install"), but repository configuration indicates pnpm.',
    });
    expect(findings[0]?.details).toContain('package.json packageManager "pnpm@10.0.0"');
    expect(findings[0]?.details).toContain("Also at line 5.");
    expect(report.failed).toBe(false);
  });

  it("accepts the matching package manager", async () => {
    const report = await check({
      "README.md": "```sh\npnpm install\npnpm build\n```\n",
      "package.json": pkg({ packageManager: "pnpm@10.0.0" }),
    });
    expect(byRule(report.findings, "package-manager")).toHaveLength(0);
  });

  it("flags yarn documented for an npm repository", async () => {
    const report = await check({ "README.md": "Run `yarn install`.", "package.json": pkg(), "package-lock.json": "{}" });
    expect(byRule(report.findings, "package-manager")).toHaveLength(1);
  });

  it("does not flag when several ecosystems are present or when there is no evidence", async () => {
    const mixed = await check({ "README.md": "```\nnpm install\n```", "package.json": pkg(), "package-lock.json": "{}", "pnpm-lock.yaml": "" });
    expect(byRule(mixed.findings, "package-manager")).toHaveLength(0);
    const none = await check({ "README.md": "```\nnpm install\n```", "package.json": pkg() });
    expect(byRule(none.findings, "package-manager")).toHaveLength(0);
  });

  it("does not flag global or package installs", async () => {
    const report = await check({
      "README.md": "```bash\nnpm install -g doceye\nnpm install doceye\nnpx doceye\n```",
      "package.json": pkg({ packageManager: "pnpm@10.0.0" }),
    });
    expect(byRule(report.findings, "package-manager")).toHaveLength(0);
  });

  it("verifies 'Uses pnpm' style claims", async () => {
    const wrong = await check({ "README.md": "This project uses pnpm.", "package.json": pkg(), "package-lock.json": "{}" });
    expect(byRule(wrong.findings, "package-manager")[0]?.message).toBe("README.md says the project uses pnpm, but repository configuration indicates npm.");
    const right = await check({ "README.md": "This project uses pnpm.", "package.json": pkg({ packageManager: "pnpm@10.0.0" }) });
    expect(byRule(right.findings, "package-manager")).toHaveLength(0);
  });

  it("can be switched off", async () => {
    const report = await check({
      "README.md": "```\nnpm install\n```",
      "package.json": pkg({ packageManager: "pnpm@10.0.0" }),
      ".doceye.yml": "rules:\n  package-manager: off\n",
    });
    expect(byRule(report.findings, "package-manager")).toHaveLength(0);
  });
});

describe("package scripts rule", () => {
  it("reports a missing script with evidence", async () => {
    const report = await check({ "README.md": "Deploy with:\n\n```bash\npnpm run deploy\n```\n", "package.json": pkg() });
    expect(byRule(report.findings, "package-scripts")).toMatchObject([
      {
        severity: "error",
        file: "README.md",
        line: 4,
        message: 'README.md references package script "deploy", but package.json does not define it.',
        subject: "deploy",
      },
    ]);
    expect(byRule(report.findings, "package-scripts")[0]?.details).toContain("Scripts defined in package.json: build, test, dev.");
  });

  it("accepts existing scripts across npm, pnpm, yarn and bun", async () => {
    const report = await check({
      "README.md": "```bash\nnpm run build\nnpm test\npnpm dev\nyarn build\nbun run build\n```",
      "package.json": pkg(),
    });
    expect(byRule(report.findings, "package-scripts")).toHaveLength(0);
  });

  it("checks inline commands too", async () => {
    const report = await check({ "README.md": "Then run `npm run lint`.", "package.json": pkg() });
    expect(byRule(report.findings, "package-scripts")).toHaveLength(1);
  });

  it("does not flag binaries from dependencies or npm's default start script", async () => {
    const withDep = await check({ "README.md": "```\nyarn tsc\npnpm eslint\n```", "package.json": pkg({ devDependencies: { tsc: "1", eslint: "9" } }) });
    expect(byRule(withDep.findings, "package-scripts")).toHaveLength(0);
    const start = await check({ "README.md": "```\nnpm start\n```", "package.json": pkg(), "server.js": "" });
    expect(byRule(start.findings, "package-scripts")).toHaveLength(0);
    const noStart = await check({ "README.md": "```\nnpm start\n```", "package.json": pkg() });
    expect(byRule(noStart.findings, "package-scripts")).toHaveLength(1);
  });

  it("skips commands after cd and workspace-scoped commands", async () => {
    const report = await check({
      "README.md": "```bash\ncd packages/web\nnpm run deploy\n```\n\n```bash\npnpm --filter web run deploy\ncd app && npm run deploy\n```",
      "package.json": pkg(),
    });
    expect(byRule(report.findings, "package-scripts")).toHaveLength(0);
  });

  it("does nothing without a package.json or with an unparsable one", async () => {
    const none = await check({ "README.md": "```\nnpm run deploy\n```" });
    expect(none.findings).toHaveLength(0);
    const broken = await check({ "README.md": "```\nnpm run deploy\n```", "package.json": "{ not json" });
    expect(broken.findings).toMatchObject([{ rule: "doceye", severity: "notice" }]);
  });

  it("reports each missing script once per file and lists the other lines", async () => {
    const report = await check({ "README.md": "```\nnpm run deploy\n```\n\nAgain: `npm run deploy`", "package.json": pkg() });
    const findings = byRule(report.findings, "package-scripts");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.details).toContain("Also at line 5.");
  });
});
