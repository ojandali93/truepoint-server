
import { Response } from 'express';
import { AuthenticatedRequest } from '../types/user.types';
import { analyzeCardForGrading } from '../lib/geminiClient';
import { supabaseAdmin } from '../lib/supabase';

const handleError = (res: Response, err: unknown) => {
  console.error('[AIGrading]', err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
};

// POST /grading/ai-analyze
// Body: { imageBase64: string, mimeType: string, cardName?: string, setName?: string }
// Analyzes a card image and returns predicted grades for PSA/BGS/CGC/TAG

export const analyzeCard = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { imageBase64, mimeType, cardName, setName } = req.body;

    if (!imageBase64) {
      res.status(400).json({ error: 'imageBase64 is required' });
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res.status(503).json({ error: 'AI grading is not configured on this server' });
      return;
    }

    const validMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const mime = mimeType ?? 'image/jpeg';
    if (!validMimeTypes.includes(mime)) {
      res.status(400).json({ error: `Invalid mimeType. Must be one of: ${validMimeTypes.join(', ')}` });
      return;
    }

    console.log(`[AIGrading] Analyzing card${cardName ? `: ${cardName}` : ''} for user ${req.user.id}`);

    const analysis = await analyzeCardForGrading(
      imageBase64,
      mime as 'image/jpeg' | 'image/png' | 'image/webp',
      cardName,
      setName,
    );

    console.log(`[AIGrading] Complete — PSA: ${analysis.predictions.psa.grade}, BGS: ${analysis.predictions.bgs.label}, confidence: ${analysis.confidence}%`);

    res.json({ data: analysis });
  } catch (err) {
    handleError(res, err);
  }
};