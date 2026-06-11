/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as campaigns from "../campaigns.js";
import type * as characterOps from "../characterOps.js";
import type * as characters from "../characters.js";
import type * as combat from "../combat.js";
import type * as crons from "../crons.js";
import type * as dice from "../dice.js";
import type * as gm_context from "../gm/context.js";
import type * as gm_memory from "../gm/memory.js";
import type * as gm_prompt from "../gm/prompt.js";
import type * as gm_tools from "../gm/tools.js";
import type * as gm_turn from "../gm/turn.js";
import type * as images from "../images.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_battleMaps from "../lib/battleMaps.js";
import type * as lib_dice from "../lib/dice.js";
import type * as lib_grid from "../lib/grid.js";
import type * as lib_llm from "../lib/llm.js";
import type * as lib_qdrant from "../lib/qdrant.js";
import type * as lib_rules5e from "../lib/rules5e.js";
import type * as messages from "../messages.js";
import type * as players from "../players.js";
import type * as presence from "../presence.js";
import type * as questFlags from "../questFlags.js";
import type * as seed from "../seed.js";
import type * as smoke from "../smoke.js";
import type * as srd_choice from "../srd/choice.js";
import type * as srd_static from "../srd/static.js";
import type * as srdData from "../srdData.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  campaigns: typeof campaigns;
  characterOps: typeof characterOps;
  characters: typeof characters;
  combat: typeof combat;
  crons: typeof crons;
  dice: typeof dice;
  "gm/context": typeof gm_context;
  "gm/memory": typeof gm_memory;
  "gm/prompt": typeof gm_prompt;
  "gm/tools": typeof gm_tools;
  "gm/turn": typeof gm_turn;
  images: typeof images;
  "lib/auth": typeof lib_auth;
  "lib/battleMaps": typeof lib_battleMaps;
  "lib/dice": typeof lib_dice;
  "lib/grid": typeof lib_grid;
  "lib/llm": typeof lib_llm;
  "lib/qdrant": typeof lib_qdrant;
  "lib/rules5e": typeof lib_rules5e;
  messages: typeof messages;
  players: typeof players;
  presence: typeof presence;
  questFlags: typeof questFlags;
  seed: typeof seed;
  smoke: typeof smoke;
  "srd/choice": typeof srd_choice;
  "srd/static": typeof srd_static;
  srdData: typeof srdData;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  presence: import("@convex-dev/presence/_generated/component.js").ComponentApi<"presence">;
};
