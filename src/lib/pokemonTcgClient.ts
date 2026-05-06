import axios, { AxiosInstance } from 'axios';
import { PokemonCard, PokemonSet, ApiListResponse, CardSearchParams } from '../types/pokemon.types';

const buildCardQuery = (params: CardSearchParams): string => {
  const parts: string[] = [];
  if (params.q) parts.push(params.q);
  if (params.setId) parts.push(`set.id:${params.setId}`);
  if (params.rarity) parts.push(`rarity:"${params.rarity}"`);
  if (params.supertype) parts.push(`supertype:${params.supertype}`);
  if (params.type) parts.push(`types:${params.type}`);
  return parts.join(' ');
};

class PokemonTcgClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.pokemontcg.io/v2',
      timeout: 15_000,
      headers: process.env.POKEMON_TCG_API_KEY
        ? { 'X-Api-Key': process.env.POKEMON_TCG_API_KEY }
        : {},
    });
  }

  async getSets(): Promise<PokemonSet[]> {
    const { data } = await this.client.get<ApiListResponse<PokemonSet>>('/sets', {
      params: { orderBy: '-releaseDate', pageSize: 250 },
    });
    return data.data;
  }

  async getSetById(setId: string): Promise<PokemonSet> {
    const { data } = await this.client.get<{ data: PokemonSet }>(
      `/sets/${encodeURIComponent(setId)}`
    );
    return data.data;
  }

  async getCardById(id: string): Promise<PokemonCard> {
    const { data } = await this.client.get<{ data: PokemonCard }>(
      `/cards/${encodeURIComponent(id)}`
    );
    return data.data;
  }

  async getCardsBySet(
    setId: string,
    page = 1,
    pageSize = 250
  ): Promise<ApiListResponse<PokemonCard>> {
    const { data } = await this.client.get<ApiListResponse<PokemonCard>>('/cards', {
      params: { q: `set.id:${setId}`, page, pageSize, orderBy: 'number' },
    });
    return data;
  }

  async searchCards(params: CardSearchParams): Promise<ApiListResponse<PokemonCard>> {
    const q = buildCardQuery(params);
    const { data } = await this.client.get<ApiListResponse<PokemonCard>>('/cards', {
      params: {
        q: q || undefined,
        page: params.page ?? 1,
        pageSize: Math.min(params.pageSize ?? 20, 250),
        orderBy: 'number',
      },
    });
    return data;
  }
}

export const pokemonTcgClient = new PokemonTcgClient();
