import { describe, expect, it } from "vitest";
import { extractLinks, findFileLink } from "../../src/ingest/connectors/html-links";
import { extractHtmlText } from "../../src/ingest/extract";

describe("extractLinks", () => {
  it("reads title and date from the row when the anchor is generic", () => {
    const html = `<table><tr><td>05/01/2099</td><td>Test circular on custody</td><td><a href="/Document/Legal/a.pdf">Download (12 KB)</a></td></tr></table>`;
    const [l] = extractLinks(html, "https://www.ifsca.gov.in/Legal/Index/x", /\.pdf$/);
    expect(l).toMatchObject({ url: "https://www.ifsca.gov.in/Document/Legal/a.pdf", title: "Test circular on custody", dateRaw: "05/01/2099" });
  });
  it("ignores javascript links and non-matching links", () => {
    const html = `<a href="javascript:void(0)">x</a><a href="/other.html">Other page title</a>`;
    expect(extractLinks(html, "https://www.sebi.gov.in/", /\.pdf$/)).toHaveLength(0);
  });
});

describe("findFileLink", () => {
  it("prefers the real file inside a PDF viewer wrapper", () => {
    const html = `<iframe src="../../../web/?file=https://www.sebi.gov.in/sebi_data/attachdocs/jan-2099/1.pdf"></iframe>`;
    expect(findFileLink(html, "https://www.sebi.gov.in/legal/circulars/jan-2099/x_1.html", /sebi_data\/.+\.pdf$/)).toBe("https://www.sebi.gov.in/sebi_data/attachdocs/jan-2099/1.pdf");
  });
});

describe("extractHtmlText", () => {
  it("drops scripts and never keeps markup", () => {
    const t = extractHtmlText(`<html><body><script>alert(1)</script><main><p>Para <b>one</b></p><p>Two</p></main></body></html>`);
    expect(t).toBe("Para one\nTwo");
  });
});
