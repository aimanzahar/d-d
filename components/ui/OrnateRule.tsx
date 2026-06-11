// Horizontal gold rule with a centered diamond — section divider ornament.
export function OrnateRule({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 ${className}`} aria-hidden>
      <span className="h-px flex-1 bg-gradient-to-r from-transparent via-gold-dim/60 to-gold-dim/80" />
      <span className="w-1.5 h-1.5 rotate-45 border border-gold/70 bg-ink" />
      <span className="h-px flex-1 bg-gradient-to-l from-transparent via-gold-dim/60 to-gold-dim/80" />
    </div>
  );
}
