import Link from "next/link";
import { logoutAction } from "./actions";

export function AdminNav({ user }: { user: string }) {
  return (
    <nav className="admin-nav" aria-label="Admin">
      <Link href="/admin">Sources &amp; health</Link>
      <Link href="/admin/review">Review queue</Link>
      <Link href="/admin/errors">Failures &amp; retries</Link>
      <Link href="/admin/runs">Crawl log</Link>
      <Link href="/admin/audit">Audit log</Link>
      <form action={logoutAction} style={{ marginLeft: "auto" }}>
        <span className="small muted">Signed in as {user} </span>
        <button className="btn ghost small" type="submit">Sign out</button>
      </form>
    </nav>
  );
}

export function Flash({ msg, error }: { msg?: string; error?: string }) {
  if (error) return <p className="flash error" role="alert">{error}</p>;
  if (msg) return <p className="flash" role="status">{msg}</p>;
  return null;
}
