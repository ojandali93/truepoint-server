// src/lib/tcgdexClient.ts
// Free, open-source Pokemon TCG API with per-card variant data
// Docs: https://tcgdex.dev — no API key required
import axios, { AxiosInstance } from "axios";

export interface TCGdexVariants {
  normal: boolean;
  reverse: boolean;
  holo: boolean;
  firstEdition: boolean;
}

export interface TCGdexCardBrief {
  id: string; // matches pokemontcg.io format e.g. "sv1-001"
  localId: string; // card number within set e.g. "001"
  name: string;
  image?: string;
  rarity?: string;
  variants: TCGdexVariants;
  // foil is on the full card object — pokeball/masterball etc.
  foil?: string;
}

export interface TCGdexCardFull extends TCGdexCardBrief {
  category: string;
  hp?: number;
  types?: string[];
  stage?: string;
  // The foil field — indicates which ball pattern is on the reverse
  // 'pokeball' | 'masterball' | 'greatball' | 'ultraball' | 'energy' |
  // 'cosmos' | 'galaxy' | 'starlight' | 'cracked-ice' | 'mirror' | etc.
}

export interface TCGdexSet {
  id: string;
  name: string;
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

  // Get all cards for a set with variant data
  // Returns brief card objects which include the variants field
  async getSetCards(setId: string): Promise<TCGdexCardBrief[]> {
    try {
      const res = await this.client.get<TCGdexCardBrief[]>(`/cards`, {
        params: {
          "filters[set.id][is]": setId,
          "pagination[pageSize]": 500,
        },
      });
      return res.data ?? [];
    } catch (err: any) {
      if (err?.response?.status === 404) return [];
      console.error(`[TCGdex] getSetCards error for ${setId}:`, err?.message);
      return [];
    }
  }

  // Get full card data including foil pattern (pokeball/masterball)
  async getCard(cardId: string): Promise<TCGdexCardFull | null> {
    try {
      const res = await this.client.get<TCGdexCardFull>(`/cards/${cardId}`);
      return res.data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      console.error(`[TCGdex] getCard error for ${cardId}:`, err?.message);
      return null;
    }
  }

  // Get all sets — used for detecting new releases
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
}

export const tcgdexClient = new TCGdexClient();
