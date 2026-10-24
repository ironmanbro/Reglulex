"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="empty" style={{ marginTop: 32 }} role="alert">
      <h1>Something went wrong</h1>
      <p>The page could not be loaded. This is usually temporary.</p>
      <button className="btn" onClick={() => reset()}>Try again</button>
    </div>
  );
}
