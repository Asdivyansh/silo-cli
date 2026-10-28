import { describe, it, expect } from "vitest";
import {
  getTemplate,
  listTemplates,
  templateNames,
  BUILTIN_TEMPLATES,
} from "../../src/integrations/templates.js";

// ---------------------------------------------------------------------------
// BUILTIN_TEMPLATES registry
// ---------------------------------------------------------------------------

describe("BUILTIN_TEMPLATES", () => {
  it("contains all expected templates", () => {
    const names = Object.keys(BUILTIN_TEMPLATES);
    expect(names).toContain("slack");
    expect(names).toContain("github");
    expect(names).toContain("hubspot");
    expect(names).toContain("linear");
    expect(names).toContain("notion");
  });

  it("every template has a valid base URL", () => {
    for (const template of Object.values(BUILTIN_TEMPLATES)) {
      expect(() => new URL(template.baseUrl)).not.toThrow();
    }
  });

  it("every template has required fields", () => {
    for (const template of Object.values(BUILTIN_TEMPLATES)) {
      expect(template.name).toBeTruthy();
      expect(template.displayName).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.baseUrl).toBeTruthy();
      expect(["bearer", "header", "query"]).toContain(template.authType);
      expect(template.tokenHint).toBeTruthy();
      expect(template.docsUrl).toBeTruthy();
    }
  });

  it("template names are lowercase with no spaces", () => {
    for (const name of Object.keys(BUILTIN_TEMPLATES)) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// getTemplate
// ---------------------------------------------------------------------------

describe("getTemplate", () => {
  it("returns the template for a known name", () => {
    const slack = getTemplate("slack");
    expect(slack).toBeDefined();
    expect(slack!.name).toBe("slack");
    expect(slack!.displayName).toBe("Slack");
    expect(slack!.baseUrl).toBe("https://slack.com/api");
  });

  it("is case-insensitive", () => {
    expect(getTemplate("SLACK")).toBeDefined();
    expect(getTemplate("Slack")).toBeDefined();
    expect(getTemplate("GITHUB")).toBeDefined();
  });

  it("returns undefined for unknown templates", () => {
    expect(getTemplate("unknown-service")).toBeUndefined();
    expect(getTemplate("")).toBeUndefined();
  });

  it("github template has extra headers", () => {
    const gh = getTemplate("github");
    expect(gh?.extraHeaders).toBeDefined();
    expect(gh?.extraHeaders?.["x-github-api-version"]).toBe("2022-11-28");
  });

  it("notion template has API version header", () => {
    const notion = getTemplate("notion");
    expect(notion?.extraHeaders).toBeDefined();
    expect(notion?.extraHeaders?.["notion-version"]).toBe("2022-06-28");
  });
});

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

describe("listTemplates", () => {
  it("returns an array of all templates", () => {
    const list = listTemplates();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(Object.keys(BUILTIN_TEMPLATES).length);
  });

  it("includes slack and github", () => {
    const names = listTemplates().map((t) => t.name);
    expect(names).toContain("slack");
    expect(names).toContain("github");
  });
});

// ---------------------------------------------------------------------------
// templateNames
// ---------------------------------------------------------------------------

describe("templateNames", () => {
  it("returns an array of template name strings", () => {
    const names = templateNames();
    expect(names).toContain("slack");
    expect(names).toContain("hubspot");
    expect(names.length).toBe(Object.keys(BUILTIN_TEMPLATES).length);
  });
});
