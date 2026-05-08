// src/lib/tcgdexClient.ts
import axios, { AxiosInstance } from "axios";

export interface TCGdexVariants {
  normal: boolean;
  reverse: boolean;
  holo: boolean;
  firstEdition: boolean;
}

export interface TCGdexCardBrief {
  id: string; // e.g. "sv1-001" — matches pokemontcg.io format
  localId: string; // e.g. "001"
  name: string;
  image?: string;
  rarity?: string;
  variants: TCGdexVariants;
  foil?: string; // 'pokeball' | 'masterball' | 'greatball' | 'energy' | etc.
}

export interface TCGdexSet {
  id: string;
  name: string;
  serie?: { id: string; name: string };
  cards: TCGdexCardBrief[];
}

class TCGdexClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: "https://api.tcgdex.net/v2/en",
      timeout: 30000,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ─── Get cards for a set with variant data ──────────────────────────────────
  // Uses GET /sets/{setId} — returns the set with CardBrief objects that include
  // the variants field (normal/reverse/holo/firstEdition booleans).
  // The old approach of GET /cards?filters[set.id][is]={setId} caused 500 errors.

  async getSetCards(setId: string): Promise<TCGdexCardBrief[]> {
    // Try the given setId first, then try common ID variations
    const idsToTry = [setId, ...this.getIdVariants(setId)];

    for (const id of idsToTry) {
      try {
        const res = await this.client.get<TCGdexSet>(`/sets/${id}`);
        const cards = res.data?.cards ?? [];
        if (cards.length > 0) {
          console.log(`[TCGdex] ✓ Set ${id} → ${cards.length} cards`);
          return cards;
        }
      } catch (err: any) {
        const status = err?.response?.status;
        if (status === 404) continue; // Try next variant
        // Any other error (500, network etc) — log and continue to next variant
        console.error(
          `[TCGdex] Error fetching set ${id}: ${status ?? err?.message}`,
        );
        continue;
      }
    }

    return []; // None of the ID variants worked
  }

  // ─── Get a single card's full data (includes foil pattern) ─────────────────
  async getCard(cardId: string): Promise<TCGdexCardBrief | null> {
    try {
      const res = await this.client.get<TCGdexCardBrief>(`/cards/${cardId}`);
      return res.data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      console.error(`[TCGdex] getCard error for ${cardId}:`, err?.message);
      return null;
    }
  }

  // ─── Get all sets for ID mapping / new release detection ───────────────────
  async getAllSets(): Promise<
    { id: string; name: string; releaseDate?: string }[]
  > {
    try {
      const res = await this.client.get("/sets");
      return res.data ?? [];
    } catch (err: any) {
      console.error("[TCGdex] getAllSets error:", err?.message);
      return [];
    }
  }

  // ─── ID variant generation ──────────────────────────────────────────────────
  // TCGdex set IDs often match pokemontcg.io but sometimes differ.
  // This generates alternative formats to try before giving up.

  private getIdVariants(setId: string): string[] {
    const variants: string[] = [];

    // Some sets use different casing or separators
    // e.g. sv1 → sv01, swsh12pt5 → swsh12.5 etc.

    // Zero-pad single digit series numbers: sv1 → sv01, swsh1 → swsh01
    const zeroPadded = setId.replace(
      /^([a-z]+)(\d)([a-z]|pt\d|$)/,
      (_, prefix, digit, suffix) => `${prefix}0${digit}${suffix}`,
    );
    if (zeroPadded !== setId) variants.push(zeroPadded);

    // Try without the series prefix entirely (some TCGdex sets use short codes)
    // e.g. sv1 might just be "sv-01" in some versions
    const withDash = setId.replace(/^([a-z]+)(\d+)/, "$1-$2");
    if (withDash !== setId) variants.push(withDash);

    return variants;
  }
}

export const tcgdexClient = new TCGdexClient();
