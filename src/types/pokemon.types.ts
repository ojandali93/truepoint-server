export interface PokemonSet {
  id: string;
  name: string;
  series: string;
  printedTotal: number;
  total: number;
  releaseDate: string;
  images: { symbol: string; logo: string };
}

export interface PokemonCard {
  id: string;
  name: string;
  number: string;
  supertype?: string;
  subtypes?: string[];
  hp?: string;
  types?: string[];
  rarity?: string;
  set: { id: string; name: string };
  images?: { small: string; large: string };
  tcgplayer?: {
    prices?: Record<
      string,
      { low?: number; mid?: number; high?: number; market?: number }
    >;
  };
}

export interface NormalizedPrice {
  cardId: string;
  source: 'tcgplayer' | 'cardmarket' | 'justtcg' | 'ebay';
  variant: string | null;
  grade: string | null;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
  fetchedAt: string;
}

export interface ApiListResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  count: number;
  totalCount: number;
}

export interface CardSearchParams {
  q?: string;
  setId?: string;
  rarity?: string;
  supertype?: string;
  type?: string;
  page?: number;
  pageSize?: number;
}
