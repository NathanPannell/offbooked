export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-screen" role="status">
      <div className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
