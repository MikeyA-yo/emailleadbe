import { ai, GEMINI_MODEL } from '../config.js'
import {
  normalizeProfileUrl, safeText, extractLinkedinProfileUrls,
  parseLinkedinTitlePage, extractJobTitleFromMeta
} from '../utils.js'
import { CrawlAttempt } from '../db.js'
import { CRAWL_COOLDOWN_MS } from '../config.js'
import mongoose from 'mongoose'

// ---- Crawl attempt tracking ----

export async function recordCrawlAttempt(attempt: {
  url: string, normalizedUrl: string, query?: string,
  status: 'success' | 'failed' | 'blocked' | 'skipped',
  reason?: string, responseStatus?: number
}) {
  if (mongoose.connection.readyState !== 1) return
  try {
    await CrawlAttempt.create({
      url: attempt.url,
      normalizedUrl: attempt.normalizedUrl,
      query: attempt.query || '',
      status: attempt.status,
      reason: attempt.reason || '',
      responseStatus: attempt.responseStatus,
      attemptedAt: new Date()
    })
  } catch (error) {
    console.error('Failed to record crawl attempt:', error)
  }
}

export async function shouldSkipDueToCooldown(normalizedUrl: string) {
  if (!normalizedUrl || mongoose.connection.readyState !== 1) return false
  try {
    const latest = await CrawlAttempt.findOne({ normalizedUrl, status: { $in: ['failed', 'blocked'] } }).sort({ attemptedAt: -1 }).lean() as any
    if (!latest?.attemptedAt) return false
    return (Date.now() - new Date(latest.attemptedAt).getTime()) < CRAWL_COOLDOWN_MS
  } catch {
    return false
  }
}

// ---- Gemini Tool implementations for LinkedIn agent ----

export async function toolSearchWeb(query: string): Promise<string> {
  if (!query) return 'empty query'
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  try {
    const response = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
    })
    if (!response.ok) {
      const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
      const bingRes = await fetch(bingUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
      })
      if (!bingRes.ok) return `Search failed: ${response.status}`
      const html = await bingRes.text()
      const urls = extractLinkedinProfileUrls(html)
      return JSON.stringify({ linkedinUrls: urls.slice(0, 5), source: 'bing' })
    }
    const html = await response.text()
    const urls = extractLinkedinProfileUrls(html)
    return JSON.stringify({ linkedinUrls: urls.slice(0, 5), source: 'duckduckgo' })
  } catch (e: any) {
    return `Search error: ${e.message}`
  }
}

export async function toolFetchLinkedInPage(url: string): Promise<string> {
  const normalizedUrl = normalizeProfileUrl(url)
  if (!normalizedUrl || !/linkedin\.com\/in\//i.test(normalizedUrl)) {
    return 'Only linkedin.com/in/ profile URLs are supported'
  }
  try {
    const response = await fetch(normalizedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
    })
    if (!response.ok) return `Fetch failed: ${response.status}`
    const html = await response.text()
    const titleMatch = html.match(/<title>(.*?)<\/title>/i)
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    const pageTitle = safeText(titleMatch?.[1] || '')
    const metaDescription = safeText(descMatch?.[1] || '')
    const parsed = parseLinkedinTitlePage(pageTitle)
    const inferredTitle = extractJobTitleFromMeta(metaDescription)
    return JSON.stringify({ url: normalizedUrl, pageTitle, metaDescription, parsedName: parsed.name, parsedCompany: parsed.company, inferredTitle })
  } catch (e: any) {
    return `Fetch error: ${e.message}`
  }
}

export const LINKEDIN_TOOL_DECLARATIONS = [
  {
    name: 'search_web',
    description: 'Search DuckDuckGo (with Bing fallback) for LinkedIn profiles. Returns an array of linkedin.com/in/ URLs found.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query, e.g. "John Smith CEO Acme Corp site:linkedin.com/in"' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_linkedin_page',
    description: 'Fetch a LinkedIn profile page and return its page title and meta description to confirm the person\'s name, title, and company.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full linkedin.com/in/ profile URL to fetch' }
      },
      required: ['url']
    }
  }
]

// ---- Find LinkedIn profile for a HubSpot contact using Gemini agent ----

export async function findLinkedInForContact(contact: any): Promise<{
  profileUrl: string; name: string; title: string; company: string; confidence: number
} | null> {
  const firstName = safeText(contact.properties?.firstname)
  const lastName = safeText(contact.properties?.lastname)
  const name = `${firstName} ${lastName}`.trim()
  const company = safeText(contact.properties?.company)
  const title = safeText(contact.properties?.jobtitle)

  if (!name) return null

  const userPrompt = `Find the LinkedIn profile URL for this person:
Name: ${name}
Company: ${company || 'unknown'}
Title: ${title || 'unknown'}

Steps:
1. Use search_web with a query like "${name} ${company} linkedin" to find candidate LinkedIn profile URLs.
2. If you get one or more linkedin.com/in/ URLs, use fetch_linkedin_page on the most likely one to confirm the name, title, and company match.
3. Return a single JSON object — no markdown fences — in this exact shape:
{"profileUrl":"","name":"","title":"","company":"","confidence":0.0}

Rules:
- profileUrl must be a linkedin.com/in/ URL, or empty string if not found.
- confidence is 0.0–1.0: use 0.9 for a strong name+company match, 0.5 for a partial match, 0.0 if not found.
- If you cannot find the right profile after searching, return {"profileUrl":"","name":"${name}","title":"${title}","company":"${company}","confidence":0.0}`

  let contents: any[] = [{ role: 'user', parts: [{ text: userPrompt }] }]
  let maxTurns = 6

  while (maxTurns-- > 0) {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: { tools: [{ functionDeclarations: LINKEDIN_TOOL_DECLARATIONS }] }
    })

    const candidate = response.candidates?.[0]
    if (!candidate?.content?.parts) break

    const parts = candidate.content.parts
    const functionCallParts = parts.filter((p: any) => p.functionCall)

    contents.push({ role: 'model', parts })

    if (functionCallParts.length === 0) {
      const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join('')
      const jsonMatch = text.match(/\{[\s\S]*?\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0])
          const profileUrl = normalizeProfileUrl(String(parsed.profileUrl || ''))
          if (profileUrl && /linkedin\.com\/in\//i.test(profileUrl)) {
            return {
              profileUrl,
              name: safeText(parsed.name) || name,
              title: safeText(parsed.title) || title,
              company: safeText(parsed.company) || company,
              confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5))
            }
          }
        } catch { /* malformed JSON — fall through */ }
      }
      break
    }

    const toolResultParts: any[] = []
    for (const part of functionCallParts) {
      const fc = part.functionCall as any
      const toolName: string = fc?.name ?? ''
      const args: any = fc?.args ?? {}
      let result = 'unknown tool'
      if (toolName === 'search_web') {
        result = await toolSearchWeb(String(args?.query || ''))
      } else if (toolName === 'fetch_linkedin_page') {
        result = await toolFetchLinkedInPage(String(args?.url || ''))
      }
      toolResultParts.push({ functionResponse: { name: toolName, response: { result } } })
    }

    contents.push({ role: 'user', parts: toolResultParts })
  }

  return null
}

// ---- Fetch and parse a LinkedIn profile page (for verification) ----

export interface LinkedInProfileData {
  profileUrl: string
  name: string
  currentCompany: string
  currentTitle: string
  headline: string
  location: string
}

export async function fetchLinkedInProfileData(profileUrl: string): Promise<LinkedInProfileData | null> {
  const normalizedUrl = normalizeProfileUrl(profileUrl)
  if (!normalizedUrl || !/linkedin\.com\/in\//i.test(normalizedUrl)) return null

  try {
    const response = await fetch(normalizedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
    })

    if (!response.ok) {
      await recordCrawlAttempt({
        url: normalizedUrl, normalizedUrl,
        status: response.status === 403 || response.status === 429 ? 'blocked' : 'failed',
        reason: `profile-http-${response.status}`, responseStatus: response.status
      })
      return null
    }

    const html = await response.text()
    const titleMatch = html.match(/<title>(.*?)<\/title>/i)
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    const pageTitle = safeText(titleMatch?.[1] || '')
    const metaDescription = safeText(descMatch?.[1] || '')

    await recordCrawlAttempt({
      url: normalizedUrl, normalizedUrl, status: 'success', responseStatus: response.status
    })

    const parsed = parseLinkedinTitlePage(pageTitle)
    const inferredTitle = extractJobTitleFromMeta(metaDescription)

    // Use AI extraction for more accurate data
    const aiData = await aiExtractProfileData(pageTitle, metaDescription, normalizedUrl)

    return {
      profileUrl: normalizedUrl,
      name: aiData?.name || parsed.name,
      currentCompany: aiData?.company || parsed.company,
      currentTitle: aiData?.title || inferredTitle,
      headline: metaDescription.split('\n')[0]?.trim() || '',
      location: aiData?.location || '',
    }
  } catch (err: any) {
    await recordCrawlAttempt({
      url: normalizedUrl, normalizedUrl, status: 'failed', reason: err.message
    })
    return null
  }
}

// ---- AI extraction helper ----

async function aiExtractProfileData(
  pageTitle: string, metaDescription: string, profileUrl: string
): Promise<{ name: string; title: string; company: string; location: string } | null> {
  const snippet = [pageTitle, metaDescription].filter(Boolean).join('\n').trim()
  if (!snippet) return null

  const prompt = `You are a data extraction assistant. Extract structured fields from this LinkedIn profile snippet.

Page Title: ${pageTitle}
Meta Description: ${metaDescription}
Profile URL: ${profileUrl}

Return ONLY a compact JSON object — no markdown fences, no explanation:
{"name":"","title":"","company":"","location":""}

Extract the person's CURRENT job title (their most recent role) and CURRENT company (where they currently work). If the description mentions multiple roles, pick the most recent/current one.`

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    })
    const raw = (response.text || '').trim()
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0])
    return {
      name: String(parsed.name || '').trim(),
      title: String(parsed.title || '').trim(),
      company: String(parsed.company || '').trim(),
      location: String(parsed.location || '').trim(),
    }
  } catch {
    return null
  }
}
