import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Foreign Investment Regulatory Library", template: "%s · FI Regulatory Library" },
  description:
    "A searchable library of Indian foreign-investment regulations — FPI, FDI, FVCI, FEMA, IFSC and taxation — collected from official sources with version history.",
  metadataBase: new URL(process.env.PUBLIC_SITE_URL || "http://localhost:3000"),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <header className="site-header">
          <div className="container bar">
            <Link href="/" className="brand" aria-label="Foreign Investment Regulatory Library — home">
              <span className="brand-mark" aria-hidden="true">FI</span>
              <span className="brand-name">
                Foreign Investment Regulatory Library
                <span>India · FPI · FDI · FVCI · FEMA · IFSC · Tax</span>
              </span>
            </Link>
            <nav className="nav" aria-label="Main">
              <Link href="/documents">Library</Link>
              <Link href="/authorities">Authorities</Link>
              <Link href="/sources">Sources &amp; coverage</Link>
              <Link href="/about">About</Link>
            </nav>
          </div>
        </header>
        <main id="main" className="container">{children}</main>
        <footer className="site-footer">
          <div className="container cols">
            <div>
              <h3>About this library</h3>
              <p>
                An independent research aid. It is not affiliated with, endorsed by, or operated on behalf of SEBI, RBI, DPIIT, IFSCA,
                the Ministry of Finance, the Income Tax Department or any government authority.
              </p>
              <p>
                The official source documents govern. Legal status shown here may require verification; this site does not provide legal advice.
              </p>
            </div>
            <div>
              <h3>Library</h3>
              <ul>
                <li><Link href="/documents">Search documents</Link></li>
                <li><Link href="/authorities">Browse by authority</Link></li>
                <li><Link href="/sources">Collection status</Link></li>
              </ul>
            </div>
            <div>
              <h3>Information</h3>
              <ul>
                <li><Link href="/about">Methodology &amp; limitations</Link></li>
                <li><Link href="/about#status">How legal status is shown</Link></li>
              </ul>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
