import type { Metadata } from "next";
import Link from "next/link";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { sourcesOverview } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sources & coverage" };

const VERIFICATION: Record<string, { label: string; tone: string; help: string }> = {
  verified: { label: "Working", tone: "good", help: "The last check against the official site succeeded." },
  unverified: { label: "Not yet checked", tone: "", help: "This source has not yet been crawled successfully." },
  failing: { label: "Check failing", tone: "bad", help: "The official site could not be reached or returned errors." },
  parser_attention: { label: "Page changed", tone: "warn", help: "The page loaded but no documents could be read; the parser needs updating." },
  blocked: { label: "Blocked", tone: "bad", help: "Access to the source is blocked." },
};

export default async function SourcesPage() {
  const { sources, targets } = await sourcesOverview();
  const enabled = sources.filter((s) => s.enabled);
  const disabled = sources.filter((s) => !s.enabled);
  const collected = targets.filter((t) => t.document_id).length;

  return (
    <>
      <h1>Sources &amp; coverage</h1>
      <p className="muted" style={{ maxWidth: 820 }}>
        Every document comes from an official publication page listed below. Each source is checked on a schedule, and every check is
        recorded. This page shows where collection is working, where it is failing, and which foundational instruments are still missing.
        The library does not claim to hold every historical document.
      </p>

      <section className="section" aria-labelledby="active">
        <div className="section-head"><h2 id="active">Active sources</h2><span className="small muted">{enabled.length} sources</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Source</th><th>Status</th><th>Last successful check</th><th>Documents</th><th>Coverage notes</th></tr>
            </thead>
            <tbody>
              {enabled.map((s) => {
                const v = VERIFICATION[s.verification_status] ?? VERIFICATION.unverified!;
                return (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.authority_short}</strong> — {s.name}
                      <div className="small muted">Checked every {s.schedule_minutes >= 60 ? `${Math.round(s.schedule_minutes / 60)} h` : `${s.schedule_minutes} min`}</div>
                    </td>
                    <td>
                      <span className={`badge ${v.tone}`} title={v.help}>{v.label}</span>
                      {s.consecutive_failures > 0 && <div className="small muted">{s.consecutive_failures} consecutive failed check{s.consecutive_failures > 1 ? "s" : ""}</div>}
                    </td>
                    <td className="small">
                      {s.last_success_at ? <>{fmtDateTime(s.last_success_at)}<br /><span className="muted">{fmtRelative(s.last_success_at)}</span></> : <span className="muted">Never</span>}
                      {s.last_run_at && s.last_run_at !== s.last_success_at && <div className="muted">Last attempt {fmtRelative(s.last_run_at)}</div>}
                    </td>
                    <td className="small count">
                      <Link href={`/documents?authority=${s.authority_code}`}>{s.documents}</Link>
                      {s.skipped > 0 && <div className="muted">{s.skipped} listed but outside scope</div>}
                      {s.failed > 0 && <div className="muted">{s.failed} failed downloads</div>}
                    </td>
                    <td className="small">{s.coverage_note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {disabled.length > 0 && (
        <section className="section" aria-labelledby="pending">
          <div className="section-head"><h2 id="pending">Configured but not yet active</h2></div>
          <p className="small muted">These sources are in the registry, but their endpoint still has to be confirmed before automatic collection starts.</p>
          <ul className="doc-list">
            {disabled.map((s) => (
              <li key={s.id}>
                <strong>{s.authority_short}</strong> — {s.name}
                <div className="small muted">{s.verification_note}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section" id="coverage" aria-labelledby="coverage-h">
        <div className="section-head">
          <h2 id="coverage-h">Foundational instruments</h2>
          <span className="small muted">{collected} of {targets.length} collected</span>
        </div>
        <p className="small muted">Core legislation and master documents the library aims to hold. An item counts as collected only when it is matched to a real document from an official source.</p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Instrument</th><th>Authority</th><th>In library</th></tr></thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td>{t.authority_code}</td>
                  <td>{t.document_id ? <Link href={`/documents/${t.document_id}`} className="badge good">Collected</Link> : <span className="badge muted">Not yet collected</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
