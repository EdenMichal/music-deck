/**
 * The one deck link every action shares. Pairing tokens live in the plugin's global settings.
 */
import streamDeck from "@elgato/streamdeck";
import { FoundryLink } from "./link";

type Globals = { tokens?: string[] };

export const link = new FoundryLink(
  {
    load: async () => (await streamDeck.settings.getGlobalSettings<Globals>()).tokens ?? [],
    save: tokens => streamDeck.settings.setGlobalSettings<Globals>({ tokens }),
  },
  undefined,
  msg => streamDeck.logger.info(msg),
);
