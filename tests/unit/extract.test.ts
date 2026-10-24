import "../helpers/env";
import { describe, expect, it } from "vitest";
import { extractPdf } from "../../src/ingest/extract";
import { blankPdf, scannedPdf, textPdf } from "../helpers/fixtures";

describe("PDF extraction", () => {
  it("extracts text page by page from a text PDF", async () => {
    const r = await extractPdf(await textPdf(["Foreign portfolio investors test line with enough characters to count as a real text layer, repeated.", "Second line of the synthetic document for extraction testing purposes."], 3));
    expect(r.status).toBe("ok");
    expect(r.method).toBe("pdftotext");
    expect(r.pageCount).toBe(3);
    expect(r.pages![2]).toContain("Page 3");
  });
  it("runs OCR on a scanned PDF and reports confidence", async () => {
    const r = await extractPdf(await scannedPdf(["Designated Depository Participant", "Registration of foreign investors", "Synthetic scanned page"]));
    expect(r.method).toBe("ocr");
    expect(r.ocrConfidence).toBeGreaterThan(0);
    expect(r.text.toLowerCase()).toContain("depository");
  });
  it("flags scanned PDFs as not searchable when OCR is off", async () => {
    const r = await extractPdf(await scannedPdf(["Some scanned text"]), { ocr: false });
    expect(r.status).toBe("ocr_unavailable");
  });
  it("flags a blank page as low-confidence OCR rather than success", async () => {
    const r = await extractPdf(await blankPdf());
    expect(r.status).toBe("ocr_low_confidence");
  });
  it("fails cleanly on corrupt input", async () => {
    const r = await extractPdf(Buffer.from("%PDF-1.4 garbage"));
    expect(["failed", "ocr_low_confidence", "ocr_unavailable"]).toContain(r.status);
  });
});
