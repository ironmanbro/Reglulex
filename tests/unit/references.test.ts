import { describe, expect, it } from "vitest";
import { deriveIdentifiers, findReferences } from "../../src/ingest/references";

describe("findReferences", () => {
  it("detects typed relationships only from wording next to an explicit citation", () => {
    const refs = findReferences(
      "In partial modification of circular SEBI/HO/AFD/P/CIR/2099/7 dated Jan 1, 2099, para 3 is amended. " +
        "Circular CIR/IMD/FPIC/1/2099 stands withdrawn. Reference is also made to RBI/2099-00/12.",
    );
    const by = Object.fromEntries(refs.map((r) => [r.norm, r.relType]));
    expect(by["SEBI/HO/AFD/P/CIR/2099/7"]).toBe("amends");
    expect(by["CIR/IMD/FPIC/1/2099"]).toBe("withdraws");
    expect(by["RBI/2099-00/12"]).toBe("related_to");
  });

  it("recognises regulations, FEMA notifications, press notes and A.P. (DIR) circulars", () => {
    const refs = findReferences(
      "under the Securities and Exchange Board of India (Foreign Portfolio Investors) Regulations, 2019, Notification No. FEMA 20(R)/2017-RB, " +
        "Press Note No. 3 (2020 Series) and A.P. (DIR Series) Circular No. 15 dated 04/01/2099. In supersession of the Foreign Exchange Management (Non-debt Instruments) Rules, 2019",
    );
    const norms = refs.map((r) => r.norm);
    expect(norms).toEqual(expect.arrayContaining([
      "REGULATIONS:SEBI:FOREIGNPORTFOLIOINVESTORS:2019", "FEMA20(R)/2017-RB", "PN3/2020", "APDIR/15/2099", "RULES:FEMA:NONDEBTINSTRUMENTS:2019",
    ]));
    expect(refs.find((r) => r.norm === "RULES:FEMA:NONDEBTINSTRUMENTS:2019")!.relType).toBe("supersedes");
  });

  it("excludes the document's own identifiers", () => {
    const refs = findReferences("Circular SEBI/HO/X/P/CIR/2099/1 issued today.", ["SEBI/HO/X/P/CIR/2099/1"]);
    expect(refs).toHaveLength(0);
  });
});

describe("deriveIdentifiers", () => {
  it("derives citation keys from the title, number and header", () => {
    const ids = deriveIdentifiers({
      title: "Securities and Exchange Board of India (Foreign Portfolio Investors) (Amendment) Regulations, 2099",
      documentNumber: "RBI/2099-00/5",
      headerText: "RBI/2099-00/5 A.P. (DIR Series) Circular No. 9 To all AD banks",
      publicationYear: 2099,
    }).map((i) => i.norm);
    expect(ids).toEqual(expect.arrayContaining(["RBI/2099-00/5", "APDIR/9", "APDIR/9/2099"]));
  });
  it("does not take a header citation preceded by citing words as the document's own number", () => {
    const ids = deriveIdentifiers({ title: "x", headerText: "In partial modification of circular SEBI/HO/X/P/CIR/2099/1, ..." }).map((i) => i.norm);
    expect(ids).not.toContain("SEBI/HO/X/P/CIR/2099/1");
  });
});
