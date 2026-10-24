import { describe, expect, it } from "vitest";
import { classify, prescreen } from "../../src/ingest/classify";

describe("classify", () => {
  it("tags FPI documents and records the triggering terms", () => {
    const c = classify({ title: "Framework for Foreign Portfolio Investors", text: "FPIs shall ... designated depository participants ... KYC ... KYC" });
    expect(c.relevance).toBe("in_scope");
    const fpi = c.tags.find((t) => t.code === "fpi")!;
    expect(fpi.terms.length).toBeGreaterThan(0);
    expect(c.tags.map((t) => t.code)).toContain("kyc_aml");
  });
  it("supports multiple routes per document", () => {
    const c = classify({ title: "Foreign investment in IFSC by FPIs", text: "International Financial Services Centre ... foreign portfolio investors ... GIFT City" });
    expect(c.tags.filter((t) => t.kind === "route").map((t) => t.code)).toEqual(expect.arrayContaining(["fpi", "ifsc"]));
  });
  it("marks unrelated material out of scope, and sources configured in scope stay in scope", () => {
    expect(classify({ title: "Mutual fund expense ratio", text: "Total expense ratio of mutual fund schemes" }).relevance).toBe("out_of_scope");
    expect(classify({ title: "Notice", text: "", assumeInScope: true }).relevance).toBe("in_scope");
  });
  it("flags weak signals as uncertain rather than in scope", () => {
    expect(classify({ title: "Revision of KYC norms for intermediaries" }).relevance).toBe("uncertain");
  });
  it("prescreen never drops in-scope-looking titles", () => {
    expect(prescreen("Amendment to FPI investment limits")).toBe("uncertain");
    expect(prescreen("Order in the matter of XYZ Ltd")).toBe("out_of_scope");
  });
});
