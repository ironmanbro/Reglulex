import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_STATUS } from "@/lib/queries";

export const metadata: Metadata = { title: "About & methodology" };

export default function About() {
  return (
    <div style={{ maxWidth: 820 }}>
      <h1>About this library</h1>
      <p className="notice">
        This is an independent research aid. It is not affiliated with SEBI, RBI, DPIIT, IFSCA, the Ministry of Finance, the Income Tax
        Department or any other authority. The official documents govern. Nothing here is legal advice.
      </p>

      <h2 className="section">What the library does</h2>
      <p>
        It collects regulatory documents on foreign investment into India from official publication pages, keeps the original files
        unchanged, extracts their text so they can be searched, and links each record to its official source.
      </p>

      <h2 className="section">How documents are collected</h2>
      <ul>
        <li>Each authority&apos;s official listing pages and feeds are checked on a schedule by a background worker, independent of website traffic.</li>
        <li>Original files are stored with a SHA-256 fingerprint. Previously collected documents are re-downloaded periodically; if the official file changes, the new file is stored as a new version and the earlier one is kept.</li>
        <li>Text is extracted from PDFs; scanned documents are processed with OCR, and low-confidence OCR is labelled as such.</li>
        <li>Broad sources (for example, all SEBI circulars) are screened for relevance to foreign investment. Items outside scope are recorded but not added to the public library.</li>
        <li>Every collection attempt is logged. Failures are shown on <Link href="/sources">Sources &amp; coverage</Link> rather than hidden.</li>
      </ul>

      <h2 className="section" id="status">How legal status is shown</h2>
      <p>
        A document is never marked as in force simply because it is the newest one found, and repeal or supersession is never inferred
        from dates alone. Relationships such as “amends” or “supersedes” are detected only from explicit citations in a document&apos;s
        text, are shown with the quoted evidence, and stay labelled <em>unconfirmed</em> until a reviewer confirms them.
      </p>
      <table className="data">
        <thead><tr><th>Label</th><th>Meaning</th></tr></thead>
        <tbody>
          {Object.values(LEGAL_STATUS).map((s) => (
            <tr key={s.label}><td>{s.label}</td><td className="small">{s.help}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ marginTop: 8 }}>A new file version means the official file changed. That is not, by itself, a legal amendment.</p>

      <h2 className="section">Limitations</h2>
      <ul>
        <li>Coverage depends on what each authority publishes online and on the collection sources that are active. See <Link href="/sources">Sources &amp; coverage</Link>.</li>
        <li>Classification tags (investment route, topic) are assigned automatically from the text and may be incomplete or imprecise until reviewed.</li>
        <li>Extracted and OCR text can contain errors. Always rely on the official document.</li>
      </ul>
    </div>
  );
}
