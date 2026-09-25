import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config";
import { buildRunOptions, DEFAULT_FAIL_ON, DEFAULT_README, type ActionInputs } from "../src/index";

const defaults = (): ActionInputs => ({
  readme: DEFAULT_README,
  config: "",
  checkExternalLinks: true,
  failOn: DEFAULT_FAIL_ON,
  cacheFile: "",
});
const env = { cwd: "/repo" };

describe("buildRunOptions: action-input precedence", () => {
  it("passes nothing through when every input is left at its documented default", () => {
    expect(buildRunOptions(defaults(), env)).toEqual({ root: "/repo" });
  });

  it("lets a config file's fail-on take effect when the action input is left at its default", () => {
    // runDocEye reads fail-on from the config file when RunOptions.failOn is unset; this only
    // verifies that leaving the input at "error" does not clobber it with an explicit override.
    expect(buildRunOptions(defaults(), env).failOn).toBeUndefined();
  });

  it("overrides the config file when an input is explicitly set to a non-default value", () => {
    expect(buildRunOptions({ ...defaults(), failOn: "warning" }, env).failOn).toBe("warning");
    expect(buildRunOptions({ ...defaults(), readme: "docs/START.md" }, env).readme).toBe("docs/START.md");
    expect(buildRunOptions({ ...defaults(), config: "custom.yml" }, env).configPath).toBe("custom.yml");
    expect(buildRunOptions({ ...defaults(), cacheFile: ".cache/links.json" }, env).cacheFile).toBe(".cache/links.json");
  });

  it("still overrides when an input is explicitly set to the same value as the default", () => {
    // GitHub always sends action.yml's default when the user does not set the input, so this
    // case is indistinguishable from "left unset" in practice, and that is the documented behavior.
    expect(buildRunOptions({ ...defaults(), failOn: "error" }, env).failOn).toBeUndefined();
  });

  it("disables external links exactly when check-external-links is false, never implicitly", () => {
    expect(buildRunOptions({ ...defaults(), checkExternalLinks: false }, env).externalLinks).toBe(false);
    expect(buildRunOptions(defaults(), env).externalLinks).toBeUndefined();
  });

  it("rejects an invalid fail-on before anything else runs", () => {
    expect(() => buildRunOptions({ ...defaults(), failOn: "sometimes" }, env)).toThrow(ConfigError);
  });

  it("uses GITHUB_WORKSPACE over cwd, and only sets slug when GITHUB_REPOSITORY is present", () => {
    expect(buildRunOptions(defaults(), { workspace: "/gh/workspace", cwd: "/repo" }).root).toBe("/gh/workspace");
    expect(buildRunOptions(defaults(), env).slug).toBeUndefined();
    expect(buildRunOptions(defaults(), { ...env, repository: "acme/tool" }).slug).toBe("acme/tool");
  });
});
