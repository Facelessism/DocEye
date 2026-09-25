import { describe, expect, it } from "vitest";
import { licenseBadgeText } from "../src/claims";
import { parseMarkdown } from "../src/markdown";

const claimsOf = (md: string) => parseMarkdown("README.md", md).claims.map((c) => c.claim);

describe("package manager claims", () => {
  it("recognizes common phrasings", () => {
    const cases: Array<[string, string]> = [
      ["This project uses pnpm.", "pnpm"],
      ["Built with `yarn`.", "yarn"],
      ["Package manager: pnpm", "pnpm"],
      ["The package manager is `bun`.", "bun"],
      ["We use yarn for development.", "yarn"],
      ["This repository prefers pnpm.", "pnpm"],
      ["Requires pnpm 9 or newer.", "pnpm"],
    ];
    for (const [text, manager] of cases) expect(claimsOf(text)).toContainEqual({ kind: "package-manager", manager });
  });

  it("ignores prose that only mentions a tool", () => {
    for (const text of ["We use the npm registry.", "Compare npm and pnpm.", "yarn is a tool."]) {
      expect(claimsOf(text).filter((c) => c.kind === "package-manager")).toEqual([]);
    }
  });
});

describe("Node.js claims", () => {
  it("recognizes common phrasings", () => {
    const cases: Array<[string, number]> = [
      ["Requires Node.js 22.", 22],
      ["Node 20+", 20],
      ["Node.js 20 or newer", 20],
      ["Node.js 20 and above", 20],
      ["Minimum Node version: 20", 20],
      ["Node 20 is required.", 20],
      ["At least Node.js 18.", 18],
      ["Requires Node.js version 22", 22],
      ["node >= 20", 20],
    ];
    for (const [text, major] of cases) {
      expect(claimsOf(text).some((c) => c.kind === "node-version" && c.major === major)).toBe(true);
    }
  });

  it("reports one claim per statement", () => {
    expect(claimsOf("Requires Node.js 22+").filter((c) => c.kind === "node-version")).toHaveLength(1);
  });

  it("ignores unrelated mentions", () => {
    for (const text of ["We love Node.", "Node-RED flows", "Tested with node 24."]) {
      expect(claimsOf(text).filter((c) => c.kind === "node-version")).toEqual([]);
    }
  });
});

describe("Docker, configuration and license claims", () => {
  it("recognizes Docker phrasings", () => {
    for (const text of ["Docker is supported.", "Available as a Docker image.", "Run with Docker:", "Dockerized and ready."]) {
      expect(claimsOf(text)).toContainEqual({ kind: "docker-support" });
    }
  });

  it("recognizes configuration locations", () => {
    const cases: Array<[string, string]> = [
      ["Configuration lives in `config/app.yml`.", "config/app.yml"],
      ["Configured via `app.config.js`.", "app.config.js"],
      ["It reads its configuration from `conf/x.yml`.", "conf/x.yml"],
      ["See `docs/options.md` for configuration.", "docs/options.md"],
      ["Edit `settings.toml` to configure the app.", "settings.toml"],
    ];
    for (const [text, path] of cases) expect(claimsOf(text)).toContainEqual({ kind: "config-location", path });
  });

  it("recognizes license statements and badges", () => {
    expect(claimsOf("Released under MIT.")).toContainEqual({ kind: "license", id: "MIT" });
    expect(claimsOf("Distributed under the Apache-2.0 license.")).toContainEqual({ kind: "license", id: "Apache-2.0" });
    expect(claimsOf("![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)")).toContainEqual({ kind: "license", id: "MIT" });
    expect(claimsOf("[![x](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)")).toContainEqual({ kind: "license", id: "Apache-2.0" });
    expect(claimsOf("![License](https://img.shields.io/github/license/o/r)").filter((c) => c.kind === "license")).toEqual([]);
  });

  it("decodes shields.io badge text", () => {
    expect(licenseBadgeText("", "https://img.shields.io/badge/license-BSD--3--Clause-green")).toBe("License: BSD-3-Clause");
    expect(licenseBadgeText("", "https://img.shields.io/badge/build-passing-green")).toBeUndefined();
    expect(licenseBadgeText("License: ISC", "logo.png")).toBe("License: ISC");
  });
});
