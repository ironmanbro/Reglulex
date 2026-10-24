// Renders a search snippet whose highlights are delimited by ⟦ ⟧. Text is rendered as
// React text nodes, never as HTML, so content extracted from documents cannot inject markup.
export function Snippet({ text }: { text: string | null }) {
  if (!text) return null;
  const parts = text.split(/(⟦[^⟧]*⟧)/g);
  return (
    <p className="snippet">
      {parts.map((p, i) => (p.startsWith("⟦") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </p>
  );
}
