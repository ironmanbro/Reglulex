import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty" style={{ marginTop: 32 }}>
      <h1>Page not found</h1>
      <p>The document or page you requested does not exist. Document links use stable IDs, so an old link may have been mistyped.</p>
      <p><Link href="/documents">Search the library</Link></p>
    </div>
  );
}
