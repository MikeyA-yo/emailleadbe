import { GoogleGenAI } from '@google/genai'
import 'dotenv/config'

// ---- Environment-driven constants ----
export const AGENT_MIN_CONFIDENCE = Number(process.env.AGENT_MIN_CONFIDENCE || '0.65')
export const CRAWL_COOLDOWN_MS = Number(process.env.AGENT_CRAWL_COOLDOWN_MS || String(6 * 60 * 60 * 1000))
export const MAX_AGENT_RESULTS = Number(process.env.AGENT_MAX_RESULTS || '50')

// ---- Domain constants ----
export type LeadSector = 'retail' | 'real_estate' | 'retail_tech' | 'commerce' | 'unknown'

export const TARGET_SECTORS: LeadSector[] = ['retail', 'real_estate', 'retail_tech', 'commerce']
export const C_SUITE_KEYWORDS = ['ceo', 'coo', 'cto', 'cfo', 'cro', 'cmo', 'cio', 'chief', 'president', 'founder']

// ---- Gemini AI client (lazy init — server boots even without GEMINI_API_KEY) ----
export const GEMINI_MODEL = 'gemini-2.5-flash'

let _ai: GoogleGenAI | null = null

export function getAI(): GoogleGenAI {
  if (!_ai) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set. AI features require a valid API key.')
    }
    _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  }
  return _ai
}

// Convenience alias for backward compat — callers use `ai` directly
export const ai = new Proxy({} as GoogleGenAI, {
  get(_target, prop) {
    return (getAI() as any)[prop]
  }
})
