// src/lib/tcgapisClient.ts
// TCGAPIs.com — single source of truth for card catalog, variants, and pricing
// Base: https://api.tcgapis.com
// Auth: x-api-key header
// Pokemon categoryId = 3

import axios from 'axios';

if (!process.env.TCGAPIS_API_KEY) {
  console.warn('[TCGAPIs] TCGAPIS_API_KEY not set');
}

export const tcgapisHttp = axios.create({
  baseURL: 'https://api.tcgapis.com',
  headers: {
    'x-api-key': process.env.TCGAPIS_API_KEY ?? '',
    'Accept': 'application/json',
  },
  timeout: 30000,
});

export const POKEMON_CATEGORY_ID = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const tcgapisGet = async <T>(
  url: string,
  params?: Record<string, any>,
  retries = 3
): Promise<T> => {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await tcgapisHttp.get<T>(url, { params });
      return res.data;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429) {
        console.log('[TCGAPIs] Rate limited — waiting 65s...');
        await sleep(65000);
        continue;
      }
      if (status === 402 || status === 403) {
        throw new Error(`Plan restriction: ${err?.response?.data?.error ?? url}`);
      }
      if (i === retries - 1) throw err;
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error(`Failed after ${retries} retries: ${url}`);
};

export { sleep };

// ─── Variant name → TruePoint internal mapping ────────────────────────────────

export const VARIANT_MAP: Record<string, { type: string; label: string; color: string; sortOrder: number }> = {
  'Normal':                 { type: 'normal',             label: 'Normal',          color: '#E5C97E', sortOrder: 0  },
  'Holofoil':               { type: 'holofoil',           label: 'Holofoil',        color: '#9B8EDB', sortOrder: 1  },
  'Reverse Holofoil':       { type: 'reverseHolofoil',    label: 'Reverse Holo',    color: '#7BC4E2', sortOrder: 2  },
  'Foil':                   { type: 'holofoil',           label: 'Holofoil',        color: '#9B8EDB', sortOrder: 1  },
  '1st Edition Normal':     { type: '1stEditionNormal',   label: '1st Edition',     color: '#F59E0B', sortOrder: 3  },
  '1st Edition Holofoil':   { type: '1stEditionHolofoil', label: '1st Ed Holo',     color: '#C9A84C', sortOrder: 4  },
  'Unlimited':              { type: 'unlimited',          label: 'Unlimited',       color: '#6B7280', sortOrder: 5  },
  'Unlimited Holofoil':     { type: 'unlimitedHolofoil',  label: 'Unlimited Holo',  color: '#8B5CF6', sortOrder: 6  },
  'Poke Ball Pattern':      { type: 'pokeball',           label: 'Poké Ball',       color: '#EF4444', sortOrder: 2  },
  'Master Ball Pattern':    { type: 'masterball',         label: 'Master Ball',     color: '#6366F1', sortOrder: 3  },
  'Energy Pattern':         { type: 'energyPattern',      label: 'Energy Pattern',  color: '#10B981', sortOrder: 4  },
  'Great Ball Pattern':     { type: 'greatball',          label: 'Great Ball',      color: '#3B82F6', sortOrder: 5  },
  'Ultra Ball Pattern':     { type: 'ultraball',          label: 'Ultra Ball',      color: '#F97316', sortOrder: 6  },
  'Cosmos Holofoil':        { type: 'cosmosHolofoil',     label: 'Cosmos Holo',     color: '#A78BFA', sortOrder: 7  },
  'Cracked Ice Holofoil':   { type: 'crackedIce',         label: 'Cracked Ice',     color: '#BAE6FD', sortOrder: 8  },
};

export const resolveVariant = (printing: string) =>
  VARIANT_MAP[printing] ?? {
    type: printing.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, ''),
    label: printing,
    color: '#6B7280',
    sortOrder: 99,
  };
