/**
 * Anthropic model registry. Source of truth for what the user is allowed to
 * pick from in the chat composer's model picker.
 *
 * Kept small and curated rather than auto-discovered so we can vouch for what
 * works: vision support (images), document support (PDFs), and reasonable
 * default for our context-heavy prompts.
 */

import type { ModelInfo } from '../../shared/types.js';

export const MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    description: 'Default. Best balance of quality, speed, and cost.',
  },
  {
    id: 'claude-opus-4-5',
    label: 'Opus 4.5',
    description: 'Most capable. Slower and more expensive; best for hard reasoning.',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    description: 'Fastest and cheapest. Good for quick lookups in this project.',
  },
];

export const DEFAULT_MODEL_ID = MODELS[0]!.id;

export function isKnownModel(id: string): boolean {
  return MODELS.some((m) => m.id === id);
}
