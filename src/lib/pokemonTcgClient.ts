import axios, { AxiosInstance } from "axios";
import type { ApiListResponse, PokemonCard, PokemonSet } from "../types/pokemon.types";

const BASE_URL = "https://api.pokemontcg.io/v2";

export class PokemonTcgClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
    });
    this.client.interceptors.request.use((config) => {
      const key = process.env.POKEMONTCG_API_KEY;
      if (key) config.headers["X-Api-Key"] = key;
      return config;
    });
  }

  async getSets(): Promise<PokemonSet[]> {
    const out: PokemonSet[] = [];
    let page = 1;
    const pageSize = 250;

    while (true) {
      const { data: payload } = await this.client.get<{
        data: unknown[];
        page?: number;
        pageSize?: number;
      }>("/sets", { params: { page, pageSize } });

      const batch = payload.data ?? [];
      for (const row of batch) {
        out.push(this.mapSet(row));
      }
      if (batch.length < pageSize) break;
      page++;
    }

    return out;
  }

  async getSetById(setId: string): Promise<PokemonSet> {
    const { data: payload } = await this.client.get<{ data: unknown }>(
      `/sets/${encodeURIComponent(setId)}`,
    );
    return this.mapSet(payload.data);
  }

  async getCardsBySet(
    setId: string,
    page: number,
    pageSize: number,
  ): Promise<ApiListResponse<PokemonCard>> {
    const { data: payload } = await this.client.get<{
      data: unknown[];
      page?: number;
      pageSize?: number;
      count?: number;
      totalCount?: number;
    }>("/cards", {
      params: {
        q: `set.id:${setId}`,
        page,
        pageSize,
      },
    });

    const rows = payload.data ?? [];
    return {
      data: rows.map((c) => this.mapCard(c)),
      page: payload.page ?? page,
      pageSize: payload.pageSize ?? pageSize,
      count: payload.count ?? rows.length,
      totalCount: payload.totalCount ?? rows.length,
    };
  }

  async getCardById(cardId: string): Promise<PokemonCard> {
    const { data: payload } = await this.client.get<{ data: unknown }>(
      `/cards/${encodeURIComponent(cardId)}`,
    );
    return this.mapCard(payload.data);
  }

  async searchCards(params: {
    q: string;
    pageSize?: number;
    page?: number;
  }): Promise<ApiListResponse<PokemonCard>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;

    const { data: payload } = await this.client.get<{
      data: unknown[];
      page?: number;
      pageSize?: number;
      count?: number;
      totalCount?: number;
    }>("/cards", {
      params: { q: params.q, page, pageSize },
    });

    const rows = payload.data ?? [];
    return {
      data: rows.map((c) => this.mapCard(c)),
      page: payload.page ?? page,
      pageSize: payload.pageSize ?? pageSize,
      count: payload.count ?? rows.length,
      totalCount: payload.totalCount ?? rows.length,
    };
  }

  private mapSet(raw: unknown): PokemonSet {
    const s = raw as Record<string, unknown>;
    const images = (s.images ?? {}) as Record<string, string>;
    return {
      id: String(s.id ?? ""),
      name: String(s.name ?? ""),
      series: String(s.series ?? ""),
      printedTotal: Number(s.printedTotal ?? s.total ?? 0),
      total: Number(s.total ?? s.printedTotal ?? 0),
      releaseDate: String(s.releaseDate ?? ""),
      images: {
        symbol: images.symbol ?? "",
        logo: images.logo ?? "",
      },
    };
  }

  private mapCard(raw: unknown): PokemonCard {
    const c = raw as Record<string, unknown>;
    const set = (c.set ?? {}) as Record<string, unknown>;
    const images = (c.images ?? {}) as Record<string, string>;
    return {
      id: String(c.id ?? ""),
      name: String(c.name ?? ""),
      number: String(c.number ?? ""),
      supertype: c.supertype as string | undefined,
      subtypes: (c.subtypes as string[]) ?? [],
      hp: c.hp != null ? String(c.hp) : undefined,
      types: (c.types as string[]) ?? [],
      rarity: c.rarity as string | undefined,
      set: {
        id: String(set.id ?? ""),
        name: String(set.name ?? ""),
      },
      images: {
        small: images.small ?? "",
        large: images.large ?? "",
      },
      tcgplayer: c.tcgplayer as PokemonCard["tcgplayer"],
    };
  }
}

export const pokemonTcgClient = new PokemonTcgClient();
