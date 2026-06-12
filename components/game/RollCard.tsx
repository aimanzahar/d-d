"use client";

type RollData = {
  notation?: string;
  dice?: { sides: number; count: number; results: number[]; dropped: number[] }[];
  modifier?: number;
  total?: number;
  success?: boolean;
  crit?: "hit" | "miss";
  dc?: number;
};

export function RollChip({ roll, label }: { roll: RollData; label: string }) {
  const die = roll.dice?.[0];
  return (
    <div
      className={`inline-flex items-center gap-3 px-3.5 py-2 border bg-ink-soft/70 ${
        roll.crit === "hit"
          ? "border-gold shadow-[0_0_18px_rgba(201,164,92,0.3)]"
          : roll.crit === "miss"
            ? "border-blood"
            : "border-gold-dim/40"
      }`}
    >
      <span className="font-dice text-[0.7rem] text-parchment-faint">{label}</span>
      {die && (
        <span className="font-dice text-xs text-parchment-dim">
          [{die.results.join(", ")}]
          {die.dropped.length > 0 && (
            <span className="line-through opacity-50 ml-1">[{die.dropped.join(", ")}]</span>
          )}
          {roll.modifier !== undefined && roll.modifier !== 0 && (
            <span className="ml-1">{roll.modifier > 0 ? `+${roll.modifier}` : roll.modifier}</span>
          )}
        </span>
      )}
      <span
        className={`font-dice text-lg font-bold ${
          roll.crit === "hit" ? "text-gold-bright" : roll.crit === "miss" ? "text-blood" : "text-parchment"
        }`}
      >
        {roll.total}
      </span>
      {roll.success !== undefined && (
        <span className={`font-dice text-[0.65rem] uppercase ${roll.success ? "text-vitality" : "text-blood"}`}>
          {roll.success ? "✓" : "✗"}
          {roll.dc !== undefined ? ` DC ${roll.dc}` : ""}
        </span>
      )}
    </div>
  );
}
