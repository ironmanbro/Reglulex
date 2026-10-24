import type { Metadata } from "next";
import { loginAction } from "../actions";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const configured = !!process.env.ADMIN_PASSWORD_HASH && (process.env.SESSION_SECRET?.length ?? 0) >= 32;
  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }} className="card">
      <h1 style={{ fontSize: "1.5rem" }}>Administrator sign in</h1>
      {!configured && (
        <p className="notice bad">Admin access is disabled: set ADMIN_PASSWORD_HASH and SESSION_SECRET (32+ characters) in the server environment.</p>
      )}
      {error && <p className="flash error" role="alert">{error === "rate" ? "Too many attempts. Try again later." : "Incorrect username or password."}</p>}
      <form action={loginAction} className="stack">
        <label>Username<input name="username" autoComplete="username" required maxLength={100} /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={200} /></label>
        <button className="btn" type="submit" disabled={!configured}>Sign in</button>
      </form>
    </div>
  );
}
