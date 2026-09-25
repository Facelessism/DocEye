import { afterEach, describe, expect, it } from "vitest";
import { findLicenseIds } from "../src/claims";
import { detectLicense } from "../src/repository";
import { byRule, check, cleanupRepos } from "./helpers";

afterEach(cleanupRepos);

const MIT_TEXT = "MIT License\n\nCopyright (c) 2026 X\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software";
const APACHE_TEXT = "                                 Apache License\n                           Version 2.0, January 2004";
const GPL3_TEXT = "                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007";

describe("license detection", () => {
  it("identifies common licenses", () => {
    expect(detectLicense(MIT_TEXT)).toBe("MIT");
    expect(detectLicense(APACHE_TEXT)).toBe("Apache-2.0");
    expect(detectLicense(GPL3_TEXT)).toBe("GPL-3.0");
    expect(detectLicense("Redistribution and use in source and binary forms ... Neither the name of X")).toBe("BSD-3-Clause");
    expect(detectLicense("Redistribution and use in source and binary forms ... provided that")).toBe("BSD-2-Clause");
    expect(detectLicense("Some custom proprietary terms")).toBeUndefined();
  });

  it("finds license ids in prose without matching inside other names", () => {
    expect(findLicenseIds("MIT or Apache-2.0")).toEqual(["MIT", "Apache-2.0"]);
    expect(findLicenseIds("LGPL-3.0")).toEqual(["LGPL-3.0"]);
    expect(findLicenseIds("permit the summit")).toEqual([]);
  });
});

describe("license rule", () => {
  it("warns when the README claims a license and no evidence exists", async () => {
    const report = await check({ "README.md": "# X\n\nLicensed under MIT.\n" });
    expect(byRule(report.findings, "license")).toMatchObject([
      {
        severity: "warning",
        line: 3,
        message: "README.md says the project is licensed under MIT, but no license evidence was found.",
      },
    ]);
  });

  it("warns when the README and the LICENSE file disagree", async () => {
    const report = await check({ "README.md": "Licensed under the MIT License.", LICENSE: APACHE_TEXT });
    const [finding] = byRule(report.findings, "license");
    expect(finding?.message).toBe("README.md says the project is licensed under MIT, but the repository indicates a different license.");
    expect(finding?.details).toContain("LICENSE identifies Apache-2.0");
  });

  it("accepts matching evidence from LICENSE files and package.json", async () => {
    const fromFile = await check({ "README.md": "Licensed under MIT.", "LICENSE.md": MIT_TEXT });
    expect(byRule(fromFile.findings, "license")).toHaveLength(0);
    const fromPkg = await check({ "README.md": "Released under the Apache-2.0 license.", "package.json": JSON.stringify({ license: "Apache-2.0" }) });
    expect(byRule(fromPkg.findings, "license")).toHaveLength(0);
    const dual = await check({ "README.md": "Licensed under MIT or Apache-2.0.", "package.json": JSON.stringify({ license: "(MIT OR Apache-2.0)" }) });
    expect(byRule(dual.findings, "license")).toHaveLength(0);
  });

  it("understands a License section that starts with the license name", async () => {
    const report = await check({ "README.md": "# X\n\n## License\n\nMIT © Someone\n" });
    expect(byRule(report.findings, "license")).toHaveLength(1);
    const ok = await check({ "README.md": "# X\n\n## License\n\nMIT © Someone\n", LICENSE: MIT_TEXT });
    expect(byRule(ok.findings, "license")).toHaveLength(0);
  });

  it("stays silent when the LICENSE file is not recognized", async () => {
    const report = await check({ "README.md": "Licensed under MIT.", LICENSE: "Custom terms." });
    expect(byRule(report.findings, "license")).toHaveLength(0);
  });

  it("normalizes -only and -or-later suffixes", async () => {
    const report = await check({ "README.md": "Licensed under GPL-3.0.", "package.json": JSON.stringify({ license: "GPL-3.0-or-later" }) });
    expect(byRule(report.findings, "license")).toHaveLength(0);
  });
});
