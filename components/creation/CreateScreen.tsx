"use client";

import { animate, stagger } from "animejs";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { ABILITY_KEYS, ABILITY_NAMES, abilityMod, fmtMod, type AbilityKey } from "@/lib/abilities";
import { Button } from "@/components/ui/Button";
import { Label, TextArea, TextInput } from "@/components/ui/Field";
import { OrnateRule } from "@/components/ui/OrnateRule";
import { Panel } from "@/components/ui/Panel";
import { StepAbilities, pointsSpent } from "./StepAbilities";
import { StepChoices, nodeSatisfied } from "./StepChoices";
import { StepClass } from "./StepClass";
import { StepRace } from "./StepRace";
import { StepSpells, expectedSpellCount } from "./StepSpells";
import { EMPTY_DRAFT, type Draft } from "./types";
import { POINT_BUY_BUDGET } from "@/lib/abilities";

type StepId = "race" | "class" | "abilities" | "choices" | "spells" | "review";

const STEP_TITLES: Record<StepId, string> = {
  race: "Lineage",
  class: "Calling",
  abilities: "Abilities",
  choices: "Training",
  spells: "Magic",
  review: "The Hero",
};

export function CreateScreen() {
  const session = useSession();
  const router = useRouter();
  const createCharacter = useMutation(api.characters.create);

  const races = useQuery(api.srdData.listRaces);
  const classes = useQuery(api.srdData.listClasses);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspiring, setInspiring] = useState(false);
  const inspireBackstory = useAction(api.inspiration.generateBackstory);

  const data = useQuery(
    api.srdData.creationData,
    draft.raceIndex && draft.classIndex
      ? {
          raceIndex: draft.raceIndex,
          subraceIndex: draft.subraceIndex ?? undefined,
          classIndex: draft.classIndex,
        }
      : "skip",
  );

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const steps: StepId[] = [
    "race",
    "class",
    "abilities",
    "choices",
    ...(data?.spellPlan ? (["spells"] as const) : []),
    "review",
  ];
  const step = steps[Math.min(stepIndex, steps.length - 1)];

  // Step entrance animation
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stageRef.current) return;
    const anim = animate(stageRef.current.children, {
      opacity: [0, 1],
      translateX: [24, 0],
      duration: 380,
      delay: stagger(40),
      ease: "out(2)",
    });
    return () => {
      anim.revert();
    };
  }, [step]);

  function canProceed(): boolean {
    switch (step) {
      case "race":
        return draft.raceIndex !== null;
      case "class":
        return draft.classIndex !== null;
      case "abilities":
        return draft.method === "standard" || pointsSpent(draft.baseScores) <= POINT_BUY_BUDGET;
      case "choices":
        return !!data && data.nodes.every((n) => nodeSatisfied(n, draft.submission[n.id]));
      case "spells":
        return (
          !!data &&
          draft.cantrips.length === data.spellPlan!.cantrips &&
          draft.spells.length === expectedSpellCount(data, draft)
        );
      case "review":
        return draft.name.trim().length > 0;
    }
  }

  // The muse writes the backstory whisper from the campaign seed + the hero
  async function handleInspireBackstory() {
    if (inspiring || !draft.raceIndex || !draft.classIndex) return;
    setInspiring(true);
    setError(null);
    try {
      const result = await inspireBackstory({
        sessionToken: session.sessionToken,
        campaignId: session.campaignId,
        raceIndex: draft.raceIndex,
        classIndex: draft.classIndex,
        name: draft.name.trim() || undefined,
        alignment: draft.alignment || undefined,
      });
      update({ notes: result.backstory });
    } catch (e) {
      const code =
        e instanceof ConvexError ? (e.data as { code?: string })?.code : null;
      setError(
        code === "muse_cooldown"
          ? "The muse needs a breath — try again in a few seconds."
          : "The muse is silent. Try again.",
      );
    } finally {
      setInspiring(false);
    }
  }

  // Final scores for the review card
  const finalScores = { ...draft.baseScores };
  for (const b of data?.summary.fixedBonuses ?? []) {
    finalScores[b.ability as AbilityKey] += b.bonus;
  }
  for (const p of draft.submission["race.abil"] ?? []) {
    if (ABILITY_KEYS.includes(p.key as AbilityKey)) finalScores[p.key as AbilityKey] += 1;
  }

  async function handleForge() {
    setBusy(true);
    setError(null);
    try {
      await createCharacter({
        sessionToken: session.sessionToken,
        name: draft.name,
        raceIndex: draft.raceIndex!,
        subraceIndex: draft.subraceIndex ?? undefined,
        classIndex: draft.classIndex!,
        alignment: draft.alignment || undefined,
        notes: draft.notes,
        abilityMethod: draft.method,
        baseScores: draft.baseScores,
        submission: draft.submission,
        cantrips: draft.cantrips,
        spells: draft.spells,
      });
      router.push(`/c/${session.inviteCode}/lobby`);
    } catch (e) {
      const detail =
        e instanceof ConvexError ? (e.data as { detail?: string; code?: string }) : null;
      setError(detail?.detail ?? detail?.code ?? "The forge sputtered. Check your choices.");
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col max-w-5xl mx-auto w-full px-6 py-10">
      <header className="text-center mb-8">
        <p className="font-display text-[0.6rem] tracking-[0.4em] uppercase text-gold-dim mb-2">
          The forge is lit
        </p>
        <h1 className="font-display text-3xl gold-text">Forge Your Hero</h1>
      </header>

      {/* progress runes */}
      <nav className="flex items-center justify-center gap-1 mb-10">
        {steps.map((s, i) => (
          <div key={s} className="flex items-center">
            <button
              className={`flex flex-col items-center gap-1.5 px-3 cursor-pointer disabled:cursor-default`}
              disabled={i > stepIndex}
              onClick={() => i < stepIndex && setStepIndex(i)}
            >
              <span
                className={`w-2.5 h-2.5 rotate-45 border transition-colors ${
                  i < stepIndex
                    ? "bg-gold border-gold"
                    : i === stepIndex
                      ? "bg-ember border-ember animate-ember-pulse"
                      : "border-gold-dim/40"
                }`}
              />
              <span
                className={`font-display text-[0.6rem] tracking-[0.2em] uppercase ${
                  i === stepIndex ? "text-ember-bright" : i < stepIndex ? "text-gold" : "text-parchment-faint"
                }`}
              >
                {STEP_TITLES[s]}
              </span>
            </button>
            {i < steps.length - 1 && <span className="w-6 h-px bg-gold-dim/30 mb-4" />}
          </div>
        ))}
      </nav>

      <div ref={stageRef} className="flex-1">
        {step === "race" && <StepRace races={races} draft={draft} update={update} />}
        {step === "class" && <StepClass classes={classes} draft={draft} update={update} />}
        {step === "abilities" && <StepAbilities draft={draft} update={update} data={data} />}
        {step === "choices" && <StepChoices data={data} draft={draft} update={update} />}
        {step === "spells" && data && <StepSpells data={data} draft={draft} update={update} />}
        {step === "review" && (
          <div className="grid md:grid-cols-2 gap-6">
            <Panel innerClassName="p-6 space-y-4">
              <label className="block">
                <Label>Name</Label>
                <TextInput
                  value={draft.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder="Thorin Ironfist"
                  maxLength={40}
                  autoFocus
                />
              </label>
              <label className="block">
                <Label>Alignment (optional)</Label>
                <select
                  className="field-arcane w-full px-3.5 py-2.5 text-[0.95rem]"
                  value={draft.alignment}
                  onChange={(e) => update({ alignment: e.target.value })}
                >
                  <option value="">— unaligned, for now —</option>
                  {["Lawful Good", "Neutral Good", "Chaotic Good", "Lawful Neutral", "True Neutral", "Chaotic Neutral", "Lawful Evil", "Neutral Evil", "Chaotic Evil"].map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="flex items-center justify-between">
                  <Label>Backstory whisper (the GM will weave it in)</Label>
                  <button
                    type="button"
                    className={`font-display text-[0.55rem] tracking-[0.2em] uppercase px-2 py-1 border border-arcane/40 text-arcane-soft hover:border-arcane cursor-pointer disabled:cursor-default disabled:hover:border-arcane/40 shrink-0 ml-3 ${
                      inspiring ? "animate-flicker" : ""
                    }`}
                    disabled={inspiring}
                    onClick={handleInspireBackstory}
                    title="Let the muse whisper a backstory grown from the campaign seed"
                  >
                    {inspiring ? "consulting the muse…" : "✦ inspire me"}
                  </button>
                </span>
                <TextArea
                  rows={4}
                  value={draft.notes}
                  onChange={(e) => update({ notes: e.target.value })}
                  placeholder="Raised by temple bells. Owes a debt to a man with no shadow…"
                  maxLength={2000}
                />
              </label>
            </Panel>
            <Panel innerClassName="p-6">
              <h3 className="font-display text-sm tracking-wider text-gold mb-4">
                {draft.name.trim() || "Unnamed"} — {draft.raceIndex} {draft.classIndex}
              </h3>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {ABILITY_KEYS.map((k) => (
                  <div key={k} className="border border-gold-dim/30 px-2 py-1.5 text-center">
                    <span className="block font-display text-[0.55rem] tracking-[0.2em] uppercase text-parchment-faint">
                      {ABILITY_NAMES[k].slice(0, 3)}
                    </span>
                    <span className="font-dice text-base text-parchment">
                      {finalScores[k]}
                      <span className="text-arcane-soft text-xs ml-1">{fmtMod(abilityMod(finalScores[k]))}</span>
                    </span>
                  </div>
                ))}
              </div>
              <OrnateRule className="my-4" />
              <dl className="font-dice text-sm space-y-1.5 text-parchment-dim">
                <div className="flex justify-between">
                  <dt>Hit points</dt>
                  <dd className="text-vitality">{(data?.summary.hitDie ?? 8) + abilityMod(finalScores.con)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Speed</dt>
                  <dd>{data?.summary.speed ?? 30} ft</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Saving throws</dt>
                  <dd className="uppercase">{data?.summary.saves.join(", ")}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Armor class</dt>
                  <dd className="font-narrative italic text-parchment-faint">derived from your gear</dd>
                </div>
              </dl>
            </Panel>
          </div>
        )}
      </div>

      <footer className="flex items-center justify-between mt-10">
        <Button
          variant="ghost"
          onClick={() => (stepIndex === 0 ? router.push(`/c/${session.inviteCode}/lobby`) : setStepIndex(stepIndex - 1))}
        >
          {stepIndex === 0 ? "Back to the table" : "Back"}
        </Button>
        {error && (
          <p className="text-blood font-narrative italic text-sm px-4" role="alert">
            {error}
          </p>
        )}
        {step === "review" ? (
          <Button variant="ember" size="lg" disabled={!canProceed() || busy} onClick={handleForge}>
            {busy ? "Forging…" : "Forge this hero"}
          </Button>
        ) : (
          <Button variant="gold" disabled={!canProceed()} onClick={() => setStepIndex(stepIndex + 1)}>
            Continue
          </Button>
        )}
      </footer>
    </div>
  );
}
