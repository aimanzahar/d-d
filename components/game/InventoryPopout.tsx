"use client";

// Graphical pack window: three equip sockets beside a draggable bag grid.
// Drag bag→socket to equip, socket→bag to unequip, within the bag to reorder;
// plain clicks still select (PointerSensor distance gate) and the selection
// bar keeps the old "use" → composer-seed behavior. Teammates get a
// view-only window into the pack.

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Panel } from "@/components/ui/Panel";
import { useSession } from "@/hooks/useSession";
import { FALLBACK_ICON, iconForItem } from "@/lib/itemIcons";
import { useComposerStore } from "@/stores/composerStore";

type InventoryItem = Doc<"characters">["inventory"][number];
type Slot = "armor" | "shield" | "weapon";
type DragData = { name: string; slot: Slot | null; fromSocket: boolean };

// --- Client mirror of the server equip-slot rule (convex/characters.ts) -----
// SRD docs aren't queryable per item from here, so the closed 2014 SRD
// armor/weapon index lists are inlined (weapons = entries with damage; the
// net has none and stays plain gear, matching the server).
const ARMOR_INDEXES = new Set([
  "padded-armor", "leather-armor", "studded-leather-armor", "hide-armor",
  "chain-shirt", "scale-mail", "breastplate", "half-plate-armor",
  "ring-mail", "chain-mail", "splint-armor", "plate-armor",
]);
const WEAPON_INDEXES = new Set([
  "club", "dagger", "greatclub", "handaxe", "javelin", "light-hammer", "mace",
  "quarterstaff", "sickle", "spear", "crossbow-light", "dart", "shortbow",
  "sling", "battleaxe", "flail", "glaive", "greataxe", "greatsword", "halberd",
  "lance", "longsword", "maul", "morningstar", "pike", "rapier", "scimitar",
  "shortsword", "trident", "war-pick", "warhammer", "whip", "blowgun",
  "crossbow-hand", "crossbow-heavy", "longbow",
]);
const WEAPON_NAME_RE = /sword|dagger|axe|bow|mace|spear|staff|hammer|blade|knife/;

function slotForItem(item: { itemIndex?: string; name: string }): Slot | null {
  if (item.itemIndex) {
    if (item.itemIndex === "shield") return "shield";
    if (ARMOR_INDEXES.has(item.itemIndex)) return "armor";
    if (WEAPON_INDEXES.has(item.itemIndex)) return "weapon";
    return null;
  }
  return WEAPON_NAME_RE.test(item.name.toLowerCase()) ? "weapon" : null;
}

const SOCKETS: { slot: Slot; label: string }[] = [
  { slot: "armor", label: "Armor" },
  { slot: "shield", label: "Shield" },
  { slot: "weapon", label: "Main hand" },
];

// Icon with a two-stage fallback: item art → _fallback.webp → first letter.
// Callers key this by item name so a slot reused for a different item gets
// fresh fallback state.
function ItemIcon({ itemIndex, name }: { itemIndex?: string; name: string }) {
  const [src, setSrc] = useState(() => iconForItem({ itemIndex, name }));
  const [exhausted, setExhausted] = useState(false);
  if (exhausted) {
    return (
      <span className="w-full h-full flex items-center justify-center font-display text-lg text-parchment-faint select-none">
        {name.charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name}
      draggable={false}
      className="w-full h-full object-cover"
      onError={() => (src === FALLBACK_ICON ? setExhausted(true) : setSrc(FALLBACK_ICON))}
    />
  );
}

function BagSlot({
  item,
  canInteract,
  selected,
  onSelect,
}: {
  item: InventoryItem;
  canInteract: boolean;
  selected: boolean;
  onSelect: (name: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.name,
    data: { name: item.name, slot: slotForItem(item), fromSocket: false } satisfies DragData,
    disabled: !canInteract,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      title={item.name}
      onClick={() => onSelect(item.name)}
      className={`relative aspect-square overflow-hidden border bg-ink/60 cursor-pointer ${
        selected ? "border-gold" : "border-gold-dim/40 hover:border-gold-dim"
      } ${isDragging ? "opacity-40" : ""}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
      {...attributes}
      {...listeners}
    >
      <ItemIcon key={item.name} itemIndex={item.itemIndex} name={item.name} />
      {item.quantity > 1 && (
        <span className="absolute bottom-0.5 right-0.5 font-dice text-[0.6rem] bg-ink/80 px-1 text-parchment">
          x{item.quantity}
        </span>
      )}
    </button>
  );
}

// The equipped item inside a socket — draggable back out to the bag.
function SocketItem({
  item,
  slot,
  canInteract,
  onSelect,
}: {
  item: InventoryItem;
  slot: Slot;
  canInteract: boolean;
  onSelect: (name: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `socket-item:${item.name}`,
    data: { name: item.name, slot, fromSocket: true } satisfies DragData,
    disabled: !canInteract,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      title={item.name}
      onClick={() => onSelect(item.name)}
      className={`relative w-full h-full overflow-hidden cursor-pointer ${isDragging ? "opacity-40" : ""}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
      {...attributes}
      {...listeners}
    >
      <ItemIcon key={item.name} itemIndex={item.itemIndex} name={item.name} />
    </button>
  );
}

function EquipSocket({
  slot,
  label,
  item,
  canInteract,
  activeDrag,
  selected,
  onSelect,
}: {
  slot: Slot;
  label: string;
  item: InventoryItem | null;
  canInteract: boolean;
  activeDrag: DragData | null;
  selected: boolean;
  onSelect: (name: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `socket:${slot}`,
    data: { slot },
    disabled: !canInteract,
  });
  // Only the socket matching the dragged item's slot reads as a valid target.
  const eligible =
    canInteract && activeDrag !== null && !activeDrag.fromSocket && activeDrag.slot === slot;
  return (
    <div>
      <p className="font-display text-[0.55rem] tracking-[0.25em] uppercase text-parchment-faint mb-1">
        {label}
      </p>
      <div
        ref={setNodeRef}
        className={`aspect-square border bg-ink/60 overflow-hidden ${
          item
            ? selected
              ? "border-gold-bright"
              : "border-gold"
            : eligible
              ? isOver
                ? "border-gold bg-gold/15"
                : "border-gold/70 bg-gold/5"
              : "border-gold-dim/40"
        }`}
      >
        {item ? (
          <SocketItem item={item} slot={slot} canInteract={canInteract} onSelect={onSelect} />
        ) : (
          <span
            className="w-full h-full flex items-center justify-center text-xl text-parchment-faint/40 select-none"
            aria-hidden
          >
            ◇
          </span>
        )}
      </div>
    </div>
  );
}

function BagGrid({
  items,
  isMe,
  canInteract,
  receiving,
  selected,
  onSelect,
}: {
  items: InventoryItem[];
  isMe: boolean;
  canInteract: boolean;
  receiving: boolean; // a socket item is mid-drag — the bag is the drop target
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id: "bag", disabled: !canInteract });
  return (
    <div
      ref={setNodeRef}
      className={`flex-1 min-h-0 overflow-y-auto border ${
        receiving ? "border-gold/50 bg-gold/5" : "border-transparent"
      }`}
    >
      {items.length === 0 ? (
        <p className="font-narrative italic text-[0.78rem] text-parchment-faint px-1 py-2">
          {isMe ? "Your pack is empty." : "Their pack is empty."}
        </p>
      ) : (
        <SortableContext items={items.map((i) => i.name)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-5 gap-2 p-1">
            {items.map((item) => (
              <BagSlot
                key={item.name}
                item={item}
                canInteract={canInteract}
                selected={selected === item.name}
                onSelect={onSelect}
              />
            ))}
          </div>
        </SortableContext>
      )}
    </div>
  );
}

export function InventoryPopout({
  character,
  isMe,
  onClose,
}: {
  character: Doc<"characters">;
  isMe: boolean;
  // Unused since the popout became a centered modal — kept so PartySidebar's
  // call site doesn't change.
  anchorTop: number;
  onClose: () => void;
}) {
  const session = useSession();
  const dialogRef = useRef<HTMLDivElement>(null);
  const dead = character.conditions.some((c) => c.name === "dead");
  const canInteract = isMe && !dead;

  const setEquipped = useMutation(api.characters.setEquipped);
  const reorderInventory = useMutation(api.characters.reorderInventory);

  const [selected, setSelected] = useState<string | null>(null);
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const [flavor, setFlavor] = useState<string | null>(null); // mutation-failure flavor text

  // Optimistic display order (names only). Reconciliation with the live
  // inventory happens in the render derivation below — vanished names are
  // skipped, fresh grants are appended — so GM edits show up immediately
  // without stomping an in-flight reorder.
  const [order, setOrder] = useState<string[]>(() => character.inventory.map((i) => i.name));

  // Focus once on mount — onClose is recreated per parent render, so keeping
  // it out of this effect stops live party updates from yanking focus back.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Escape cancels an active drag (dnd-kit behavior) — only close the modal
  // when no drag is in flight. Ref, not state: the listener registers once.
  const dragActiveRef = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !dragActiveRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Everything below derives from the live character prop each render; the
  // local `order` array only decides arrangement, never contents.
  const byName = new Map(character.inventory.map((i) => [i.name, i]));
  const fullOrder: InventoryItem[] = [];
  for (const name of order) {
    const item = byName.get(name);
    if (item) {
      fullOrder.push(item);
      byName.delete(name);
    }
  }
  for (const item of byName.values()) fullOrder.push(item); // just granted, not yet in `order`

  // Equipped items render in their socket only. Anything equipped that maps
  // to no slot (odd GM grants) stays visible in the bag instead of vanishing.
  const socketItems: Partial<Record<Slot, InventoryItem>> = {};
  const socketedNames = new Set<string>();
  for (const item of fullOrder) {
    if (!item.equipped) continue;
    const slot = slotForItem(item);
    if (slot && !socketItems[slot]) {
      socketItems[slot] = item;
      socketedNames.add(item.name);
    }
  }
  const bagItems = fullOrder.filter((i) => !socketedNames.has(i.name));
  const bagNames = bagItems.map((i) => i.name);

  const selectedItem = selected
    ? (character.inventory.find((i) => i.name === selected) ?? null)
    : null;
  const selectedSlot = selectedItem ? slotForItem(selectedItem) : null;
  const activeItem = activeDrag
    ? (character.inventory.find((i) => i.name === activeDrag.name) ?? null)
    : null;

  // Distance gate: a plain click never starts a drag, so slots stay clickable.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragStart = (e: DragStartEvent) => {
    const data = (e.active.data.current as DragData | undefined) ?? null;
    dragActiveRef.current = true;
    setActiveDrag(data);
    if (data) setSelected(data.name);
    setFlavor(null);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    dragActiveRef.current = false;
    setActiveDrag(null);
    const data = e.active.data.current as DragData | undefined;
    if (!data || !e.over) return;
    const overId = String(e.over.id);

    if (data.fromSocket) {
      // Socket → anywhere over the bag (the container or any cell): unequip.
      if (overId === "bag" || bagNames.includes(overId)) {
        void setEquipped({
          sessionToken: session.sessionToken,
          itemName: data.name,
          equipped: false,
        }).catch(() => setFlavor("The buckles refuse to come loose."));
      }
      return;
    }
    if (overId.startsWith("socket:")) {
      // Bag → socket: only the matching slot accepts.
      if (data.slot === overId.slice("socket:".length)) {
        void setEquipped({
          sessionToken: session.sessionToken,
          itemName: data.name,
          equipped: true,
        }).catch(() => setFlavor("That cannot be worn or wielded."));
      }
      return;
    }
    // Bag → bag: optimistic local reorder; the server resolves names against
    // its authoritative array, so stale client indexes can't move the wrong
    // item (rapid second drags, concurrent GM grants).
    if (overId !== String(e.active.id) && bagNames.includes(overId)) {
      const fromLocal = fullOrder.findIndex((i) => i.name === data.name);
      const toLocal = fullOrder.findIndex((i) => i.name === overId);
      if (fromLocal === -1 || toLocal === -1) return;
      setOrder(arrayMove(fullOrder.map((i) => i.name), fromLocal, toLocal));
      void reorderInventory({
        sessionToken: session.sessionToken,
        movedName: data.name,
        targetName: overId,
      }).catch(() => {
        setOrder(character.inventory.map((i) => i.name)); // roll back the optimistic move
        setFlavor("The pack shifts, then settles as it was.");
      });
    }
  };

  const handleUse = (name: string) => {
    useComposerStore.getState().setSeed(`I use my ${name}`);
    onClose();
  };

  const toggleEquip = (item: InventoryItem) => {
    setFlavor(null);
    void setEquipped({
      sessionToken: session.sessionToken,
      itemName: item.name,
      equipped: !item.equipped,
    }).catch(() => setFlavor("That cannot be worn or wielded."));
  };

  const { cp, sp, ep, gp, pp } = character.currency;
  // Portal: the sidebar wrapper's backdrop-blur makes it a containing block
  // for fixed descendants — escape to <body> so viewport coords hold and the
  // scrim actually covers the whole screen.
  return createPortal(
    <>
      <div className="fixed inset-0 z-30 bg-ink/70" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-label={`${character.name}'s inventory`}
        className="fixed z-30 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(92vw,640px)] outline-none"
      >
        <Panel innerClassName="flex flex-col max-h-[86vh]">
          <div className="flex items-center justify-between gap-2 border-b border-gold-dim/30 px-3.5 py-2.5">
            <span className="font-display text-[0.6rem] tracking-[0.25em] uppercase text-gold truncate">
              {character.name}&apos;s pack
            </span>
            <button
              className="text-parchment-faint hover:text-parchment cursor-pointer shrink-0"
              onClick={onClose}
              aria-label="Close inventory"
            >
              ✕
            </button>
          </div>
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              dragActiveRef.current = false;
              setActiveDrag(null);
            }}
          >
            <div className="flex gap-4 px-3.5 py-3 flex-1 min-h-0">
              <div className="w-36 shrink-0 flex flex-col gap-2.5 overflow-y-auto">
                {SOCKETS.map(({ slot, label }) => (
                  <EquipSocket
                    key={slot}
                    slot={slot}
                    label={label}
                    item={socketItems[slot] ?? null}
                    canInteract={canInteract}
                    activeDrag={activeDrag}
                    selected={selected !== null && selected === socketItems[slot]?.name}
                    onSelect={setSelected}
                  />
                ))}
              </div>
              <BagGrid
                items={bagItems}
                isMe={isMe}
                canInteract={canInteract}
                receiving={canInteract && !!activeDrag?.fromSocket}
                selected={selected}
                onSelect={setSelected}
              />
            </div>
            {/* Overlay portals to <body>: the dialog's -translate-x/y-1/2
                makes it a containing block for fixed elements, which would
                offset the drag ghost far from the cursor */}
            {createPortal(
              <DragOverlay dropAnimation={null}>
                {activeItem ? (
                  <div className="w-12 h-12 border border-gold bg-ink/90 overflow-hidden">
                    <ItemIcon
                      key={activeItem.name}
                      itemIndex={activeItem.itemIndex}
                      name={activeItem.name}
                    />
                  </div>
                ) : null}
              </DragOverlay>,
              document.body,
            )}
          </DndContext>
          <div className="border-t border-gold-dim/30 px-3.5 py-2 flex items-center gap-2 min-h-[2.75rem]">
            {selectedItem ? (
              <>
                <span className="font-narrative text-[0.85rem] text-parchment truncate flex-1">
                  {selectedItem.name}
                  {selectedItem.quantity > 1 && (
                    <span className="font-dice text-[0.65rem] text-parchment-dim">
                      {" "}
                      x{selectedItem.quantity}
                    </span>
                  )}
                </span>
                {flavor && (
                  <span className="font-narrative italic text-[0.7rem] text-blood/90 truncate">
                    {flavor}
                  </span>
                )}
                <button
                  className="font-display text-[0.6rem] tracking-[0.25em] uppercase border border-gold-dim/40 text-gold px-2 py-1 hover:bg-gold/10 cursor-pointer disabled:opacity-50 disabled:cursor-default disabled:hover:bg-transparent shrink-0"
                  disabled={!canInteract}
                  title={isMe ? `Use ${selectedItem.name}` : "Only your own gear can be used"}
                  onClick={() => handleUse(selectedItem.name)}
                >
                  ✦ use
                </button>
                {canInteract && selectedSlot && (
                  <button
                    className="font-display text-[0.6rem] tracking-[0.25em] uppercase border border-gold-dim/40 text-gold px-2 py-1 hover:bg-gold/10 cursor-pointer shrink-0"
                    onClick={() => toggleEquip(selectedItem)}
                  >
                    {selectedItem.equipped ? "unequip" : "equip"}
                  </button>
                )}
              </>
            ) : (
              <span className="font-narrative italic text-[0.78rem] text-parchment-faint">
                {flavor ?? "Touch an item to inspect it."}
              </span>
            )}
          </div>
          <div className="border-t border-gold-dim/30 px-3.5 py-2 flex gap-3 font-dice text-[0.65rem]">
            <span className="text-gold">{gp} gp</span>
            {pp > 0 && <span className="text-parchment-dim">{pp} pp</span>}
            {sp > 0 && <span className="text-parchment-dim">{sp} sp</span>}
            {cp > 0 && <span className="text-parchment-dim">{cp} cp</span>}
            {ep > 0 && <span className="text-parchment-dim">{ep} ep</span>}
          </div>
        </Panel>
      </div>
    </>,
    document.body,
  );
}
