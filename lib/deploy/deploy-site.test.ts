import { describe, expect, test } from "@jest/globals";
import { kvsKeyForSite, normalizeSitePath } from "./deploy-site.js";

describe("deploy-site helpers", () => {
  test("normalizeSitePath and kvsKeyForSite", () => {
    expect(normalizeSitePath(undefined)).toBeUndefined();
    expect(normalizeSitePath("")).toBeUndefined();
    expect(normalizeSitePath("/admin/")).toBe("admin");
    expect(kvsKeyForSite(undefined)).toBe("current-version");
    expect(kvsKeyForSite("apps/vite")).toBe("current-version__apps__vite");
  });
});
