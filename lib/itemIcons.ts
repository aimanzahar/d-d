// Inventory icon resolution. AI-generated art lives at
// public/icons/items/{srd-index}.webp (one per 2014 SRD equipment index, plus
// _fallback.webp). Custom items without an index get keyword-bucketed onto a
// real SRD icon so the bag never falls back to bare text.

import { withBasePath } from "@/lib/basePath";

export const FALLBACK_ICON = withBasePath("/icons/items/_fallback.webp");

// First match wins — narrower words come first (arrow|bolt before bow so a
// "crossbow bolt" doesn't get a bow). Every target is a real SRD equipment
// index with a generated icon; there is no potion in SRD equipment, so the
// potion bucket borrows the vial.
const KEYWORD_BUCKETS: [RegExp, string][] = [
  [/dagger|knife/, "dagger"],
  [/arrow|bolt/, "arrow"],
  [/sword|blade/, "longsword"],
  [/bow/, "shortbow"],
  [/axe/, "handaxe"],
  [/mace|club|flail|morningstar/, "mace"],
  [/spear|javelin|pike|lance|trident/, "spear"],
  [/staff|wand|rod/, "quarterstaff"],
  [/hammer|maul/, "warhammer"],
  [/shield|buckler/, "shield"],
  [/helm|armor|armour|mail|plate|cuirass/, "chain-mail"],
  [/boot|sandal|shoe/, "clothes-travelers"],
  [/cloak|cape|robe|mantle/, "robes"],
  [/ring/, "signet-ring"],
  [/amulet|necklace|pendant|talisman/, "amulet"],
  [/scroll|map/, "case-map-or-scroll"],
  [/potion|elixir|vial|flask|tonic/, "vial"],
  [/torch/, "torch"],
  [/lantern|lamp/, "lantern-hooded"],
  [/gem|jewel|diamond|ruby|emerald|pearl|coin|gold|silver|treasure/, "pouch"],
  [/rope|cord|twine/, "rope-hempen-50-feet"],
  [/food|ration|bread|meat|cheese/, "rations-1-day"],
  [/water|canteen/, "waterskin"],
  [/book|tome|grimoire/, "book"],
];

export function iconForItem(item: { itemIndex?: string; name: string }): string {
  if (item.itemIndex) return withBasePath(`/icons/items/${item.itemIndex}.webp`);
  const name = item.name.toLowerCase();
  for (const [pattern, index] of KEYWORD_BUCKETS) {
    if (pattern.test(name)) return withBasePath(`/icons/items/${index}.webp`);
  }
  return FALLBACK_ICON;
}
