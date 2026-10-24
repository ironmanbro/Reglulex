import { LEGAL_STATUS, type LegalStatus } from "@/lib/queries";

export function StatusBadge({ status }: { status: string }) {
  const s = LEGAL_STATUS[status as LegalStatus] ?? LEGAL_STATUS.unknown;
  return (
    <span className={`badge ${s.tone === "neutral" ? "" : s.tone}`} title={s.help}>
      {s.label}
    </span>
  );
}
