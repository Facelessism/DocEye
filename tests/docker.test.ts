import { afterEach, describe, expect, it } from "vitest";
import { parseCompose, parseDockerBuild } from "../src/checks/docker";
import { byRule, check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

describe("docker command parsing", () => {
  const t = (line: string) => line.split(" ");

  it("finds the Dockerfile a build reads", () => {
    expect(parseDockerBuild(t("docker build ."))).toEqual({ dockerfile: "Dockerfile" });
    expect(parseDockerBuild(t("docker build -t app:latest ."))).toEqual({ dockerfile: "Dockerfile" });
    expect(parseDockerBuild(t("docker build -f docker/Dockerfile.prod -t x ."))).toEqual({ dockerfile: "docker/Dockerfile.prod" });
    expect(parseDockerBuild(t("docker build --file=Dockerfile.dev ."))).toEqual({ dockerfile: "Dockerfile.dev" });
    expect(parseDockerBuild(t("docker buildx build --platform linux/amd64 ./app"))).toEqual({ dockerfile: "app/Dockerfile" });
  });

  it("ignores builds it cannot resolve statically", () => {
    for (const line of ["docker build", "docker build -", "docker build https://github.com/a/b.git", "docker build $CTX", "docker run x", "docker build ../elsewhere"]) {
      expect(parseDockerBuild(t(line))).toBeUndefined();
    }
  });

  it("finds compose files and skips non-service subcommands", () => {
    expect(parseCompose(t("docker compose up"))).toEqual({ files: [] });
    expect(parseCompose(t("docker-compose -f a.yml -f b.yml up -d"))).toEqual({ files: ["a.yml", "b.yml"] });
    expect(parseCompose(t("docker compose --project-directory x up"))).toBeUndefined();
    expect(parseCompose(t("docker compose version"))).toBeUndefined();
    expect(parseCompose(t("docker ps"))).toBeUndefined();
  });
});

describe("docker rule", () => {
  it("reports docker build without a Dockerfile", async () => {
    const report = await check({ "README.md": "```bash\ndocker build -t app .\n```\n" });
    expect(byRule(report.findings, "docker")).toMatchObject([
      {
        severity: "error",
        line: 2,
        message: 'README.md runs "docker build -t app .", but Dockerfile does not exist.',
        details: "The repository contains no Dockerfile in its root or docker/ directory.",
      },
    ]);
  });

  it("accepts a valid Docker reference", async () => {
    const report = await check({
      "README.md": "```bash\ndocker build -t app .\ndocker compose up -d\n```\n\nSee `Dockerfile` and `docker-compose.yml`.",
      Dockerfile: "FROM node:22",
      "docker-compose.yml": "services: {}",
    });
    expect(byRule(report.findings, "docker")).toHaveLength(0);
  });

  it("reports docker compose without a compose file, and missing -f files", async () => {
    const none = await check({ "README.md": "```\ndocker compose up\n```" });
    expect(byRule(none.findings, "docker")[0]?.message).toBe('README.md runs "docker compose up", but no Compose file exists in the repository root.');
    const explicit = await check({ "README.md": "```\ndocker-compose -f deploy/prod.yml up\n```", "compose.yaml": "services: {}" });
    expect(byRule(explicit.findings, "docker")[0]?.message).toContain("Compose file deploy/prod.yml does not exist");
  });

  it("reports inline references to missing Docker files, but not files the reader should create", async () => {
    const report = await check({
      "README.md": "Build with `Dockerfile`.\n\nCreate a `docker-compose.yml` like this.\n\nSee [`Dockerfile`](Dockerfile).",
    });
    const findings = byRule(report.findings, "docker");
    expect(findings.map((f) => f.line)).toEqual([1]);
    expect(findings[0]?.message).toBe("README.md references Dockerfile, but it does not exist.");
  });

  it("treats 'Docker is supported' as a warning-level claim", async () => {
    const report = await check({ "README.md": "Docker is supported.\n" });
    expect(byRule(report.findings, "docker")).toMatchObject([
      { severity: "warning", message: "README.md says Docker is supported, but the repository contains no Dockerfile or Compose file." },
    ]);
    const ok = await check({ "README.md": "Docker is supported.\n", Dockerfile: "FROM scratch" });
    expect(byRule(ok.findings, "docker")).toHaveLength(0);
  });

  it("finds Dockerfiles in docker/ for -f references", async () => {
    const report = await check({ "README.md": "```\ndocker build -f docker/Dockerfile .\n```", "docker/Dockerfile": "FROM scratch" });
    expect(byRule(report.findings, "docker")).toHaveLength(0);
  });
});
