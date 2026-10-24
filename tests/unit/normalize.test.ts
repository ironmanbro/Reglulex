import { describe, expect, it } from "vitest";
import { canonicalUrl, fileFormatFrom, inferDocumentType, normalizeDocNumber, parseIndianDate } from "../../src/ingest/normalize";

describe("parseIndianDate", () => {
  it.each([
    ["Oct 14, 2026", "2026-10-14"],
    ["October 14, 2026", "2026-10-14"],
    ["14/10/2026", "2026-10-14"],
    ["04-01-2026", "2026-01-04"], // day-first
    ["14.10.2026", "2026-10-14"],
    ["14th October, 2026", "2026-10-14"],
    ["14-Oct-2026", "2026-10-14"],
    ["2026-10-14", "2026-10-14"],
    ["Tue, 13 Oct 2026 20:00:00 GMT", "2026-10-14"], // IST calendar date
  ])("%s → %s", (raw, want) => expect(parseIndianDate(raw)).toBe(want));

  it("rejects impossible dates instead of guessing", () => {
    expect(parseIndianDate("31/02/2026")).toBeNull();
    expect(parseIndianDate("no date here")).toBeNull();
    expect(parseIndianDate(null)).toBeNull();
  });
});

describe("normalizeDocNumber", () => {
  it("canonicalises spacing, case and dashes", () => {
    expect(normalizeDocNumber(" SEBI/HO/AFD/AFD-PoD-2/P/CIR/2024/12 ")).toBe("SEBI/HO/AFD/AFD-POD-2/P/CIR/2024/12");
    expect(normalizeDocNumber("RBI/2024–25/12")).toBe("RBI/2024-25/12");
    expect(normalizeDocNumber("ab")).toBeNull();
  });
});

describe("inferDocumentType", () => {
  it("lets strong title markers override the source hint", () => {
    expect(inferDocumentType("Corrigendum to circular on FPIs", "circular")).toBe("corrigendum");
    expect(inferDocumentType("Securities and Exchange Board of India (Foreign Portfolio Investors) (Amendment) Regulations, 2026", "regulations")).toBe("amendment");
    expect(inferDocumentType("Master Direction - Foreign Investment in India", null)).toBe("master_direction");
  });
  it("uses the hint for ordinary titles and falls back to title cues", () => {
    expect(inferDocumentType("Framework for FPIs", "circular")).toBe("circular");
    expect(inferDocumentType("Press Note No. 3 (2020 Series)", null)).toBe("press_note");
    expect(inferDocumentType("Foreign Exchange Management (Non-debt Instruments) Rules, 2019", null)).toBe("rules");
    expect(inferDocumentType("Something", null)).toBe("unknown");
  });
});

describe("canonicalUrl / fileFormatFrom", () => {
  it("drops fragments and tracking parameters, resolves relative URLs", () => {
    expect(canonicalUrl("../a/b.pdf?utm_source=x#p2", "https://www.sebi.gov.in/legal/c/")).toBe("https://www.sebi.gov.in/legal/a/b.pdf");
    expect(canonicalUrl("javascript:alert(1)")).toBeNull();
  });
  it("detects format from magic bytes, not just headers", () => {
    expect(fileFormatFrom(Buffer.from("%PDF-1.7 ..."), "text/html", "x.html")).toBe("pdf");
    expect(fileFormatFrom(Buffer.from("<!DOCTYPE html><html>"), "application/octet-stream", "x")).toBe("html");
    expect(fileFormatFrom(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), "", "x.doc")).toBe("doc");
  });
});
