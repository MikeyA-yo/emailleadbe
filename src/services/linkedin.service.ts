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

// ---- LinkedIn profile discovery ----

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface ProbeResult {
  url: string
  pageTitle: string
  metaDescription: string
}

async function probeLinkedInUrl(candidateUrl: string): Promise<ProbeResult | null> {
  try {
    const response = await fetch(candidateUrl, {
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow',
    })
    if (!response.ok) {
      console.log(`[LinkedIn Probe] ${response.status}: ${candidateUrl}`)
      return null
    }
    const html = await response.text()
    const titleMatch = html.match(/<title>(.*?)<\/title>/i)
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    return {
      url: candidateUrl,
      pageTitle: titleMatch?.[1] || '',
      metaDescription: descMatch?.[1] || '',
    }
  } catch (e: any) {
    console.log(`[LinkedIn Probe] Error for ${candidateUrl}: ${e.message}`)
    return null
  }
}

// ---- Gemini Google Search Grounding — find LinkedIn URLs via Google ----

interface GeminiSearchResult {
  urls: string[]
  intel: { name: string; title: string; company: string } | null
}

// Clean up filler phrases from regex-extracted titles
// e.g. "individual is currently working as a Creative Director" → "Creative Director"
function cleanExtractedTitle(title: string): string {
  return title
    .replace(/^(?:this\s+)?(?:individual|person|they?)\s+(?:is\s+)?(?:currently\s+)?(?:working\s+as\s+)?(?:a\s+|an\s+)?/i, '')
    .replace(/^(?:currently\s+)?(?:working\s+as\s+)?(?:a\s+|an\s+)?/i, '')
    .replace(/^(?:identified\s+as\s+)?(?:a\s+|an\s+)?/i, '')
    .trim()
}

// Single Gemini grounding attempt — returns response text + grounding metadata
async function attemptGeminiGrounding(prompt: string): Promise<{
  text: string
  groundingMeta: any
  groundingUrls: string[]
  allUrls: string[]
  groundingFired: boolean
}> {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
    },
  })

  const text = (response.text || '').trim()
  const groundingMeta = (response as any).candidates?.[0]?.groundingMetadata

  let groundingUrls: string[] = []
  if (groundingMeta?.groundingChunks) {
    for (const chunk of groundingMeta.groundingChunks) {
      if (chunk.web?.uri && chunk.web.uri.includes('linkedin.com/in/')) {
        groundingUrls.push(chunk.web.uri)
      }
    }
  }

  // Extract URLs from text
  const urlRegexFull = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_%-]+/g
  const urlRegexBare = /(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_%-]+/g
  const textUrlsFull = text.match(urlRegexFull) || []
  const textUrlsBare = (text.match(urlRegexBare) || []).map(u =>
    u.startsWith('http') ? u : `https://${u.startsWith('www.') ? u : 'www.' + u}`
  )
  const allUrls = [...new Set([...groundingUrls, ...textUrlsFull, ...textUrlsBare])]

  // Grounding "fired" if we got groundingChunks or groundingSupports (not just searchEntryPoint/webSearchQueries)
  const groundingFired = !!(groundingMeta?.groundingChunks || groundingMeta?.groundingSupports)

  return { text, groundingMeta, groundingUrls, allUrls, groundingFired }
}

async function searchLinkedInWithGemini(name: string, company: string, jobTitle: string): Promise<GeminiSearchResult> {
  try {
    // Attempt 1: standard prompt
    const prompt1 = `Search Google for the LinkedIn profile of ${name} who works at ${company} as ${jobTitle}.

I need to know:
1. What is their LinkedIn profile URL (linkedin.com/in/...)?
2. What company do they currently work at according to LinkedIn?
3. What is their current job title according to LinkedIn?

Please search and tell me what you find.`

    let result = await attemptGeminiGrounding(prompt1)
    console.log(`[LinkedIn Gemini Search] "${name}" at "${company}" → response: ${result.text.substring(0, 500)}`)

    if (result.groundingMeta) {
      console.log(`[LinkedIn Gemini Search] Grounding metadata present: ${JSON.stringify(Object.keys(result.groundingMeta))}`)
    } else {
      console.log(`[LinkedIn Gemini Search] No grounding metadata — search may not have triggered`)
    }

    // Attempt 2: retry with rephrased prompt if grounding didn't fire
    if (!result.groundingFired) {
      console.log(`[LinkedIn Gemini Search] Grounding didn't fire for "${name}" — retrying with rephrased prompt`)
      const prompt2 = `Find information about ${name} ${company} on LinkedIn. What is their current role and company? Search for "${name} ${company} LinkedIn" and tell me what you find about this person.`

      const retry = await attemptGeminiGrounding(prompt2)
      console.log(`[LinkedIn Gemini Search] Retry response: ${retry.text.substring(0, 300)}`)
      if (retry.groundingMeta) {
        console.log(`[LinkedIn Gemini Search] Retry grounding metadata: ${JSON.stringify(Object.keys(retry.groundingMeta))}`)
      }

      // Use retry result if it got better grounding, otherwise merge URLs
      if (retry.groundingFired) {
        console.log(`[LinkedIn Gemini Search] Retry succeeded — grounding fired`)
        result = retry
      } else {
        console.log(`[LinkedIn Gemini Search] Retry also failed — no grounding on either attempt`)
        // Merge any URLs found across both attempts
        result.allUrls = [...new Set([...result.allUrls, ...retry.allUrls])]
        // Use the longer text response (more likely to have useful info)
        if (retry.text.length > result.text.length) {
          result.text = retry.text
        }
      }
    }

    const { text, allUrls } = result

    // Extract structured intel from the prose response
    let intel: GeminiSearchResult['intel'] = null
    if (text.length > 30) {
      // First try: regex patterns to extract company/title from common phrasings
      // e.g. "is a Managing Partner at Forerunner Ventures" or "currently works at Shopify"
      const roleAtCompanyRegex = /(?:is\s+(?:a\s+|an\s+|currently\s+(?:a\s+|an\s+)?)?)([\w\s,]+?)\s+at\s+([\w\s&.,]+?)(?:\.|,|\s+(?:a\s|and\s|who\s|in\s|based|since|where|Her|His|The|$))/gi
      const matches = [...text.matchAll(roleAtCompanyRegex)]
      if (matches.length > 0) {
        const bestMatch = matches[0]
        let extractedTitle = cleanExtractedTitle(bestMatch[1].trim())
        const extractedCompany = bestMatch[2].trim()
        // If regex title is too long (>60 chars), it's likely too greedy — fall through to AI
        if (extractedTitle.length <= 60 && extractedTitle.length > 0) {
          intel = {
            name,
            title: extractedTitle,
            company: extractedCompany,
          }
          console.log(`[LinkedIn Gemini Search] Regex extracted: "${intel.title}" @ "${intel.company}"`)
        } else {
          console.log(`[LinkedIn Gemini Search] Regex title too long or empty after cleanup (${extractedTitle.length} chars), falling through to AI extraction`)
        }
      }

      // Second try: AI extraction if regex didn't work
      if (!intel) {
        try {
          const extractResponse = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: `Read this text about ${name} (HubSpot says they work at "${company}"):

"${text.substring(0, 1500)}"

What is ${name}'s CURRENT job title and CURRENT company? Return ONLY JSON, no markdown:
{"currentTitle":"","currentCompany":""}`,
          })
          const extractText = (extractResponse.text || '').trim()
          console.log(`[LinkedIn Gemini Search] Extraction AI response: ${extractText.substring(0, 200)}`)
          // Strip markdown fences if present
          const cleaned = extractText.replace(/```json\s*/g, '').replace(/```\s*/g, '')
          const extractMatch = cleaned.match(/\{[\s\S]*\}/)
          if (extractMatch) {
            const parsed = JSON.parse(extractMatch[0])
            if (parsed.currentCompany || parsed.currentTitle) {
              intel = {
                name,
                title: cleanExtractedTitle(String(parsed.currentTitle || '').trim()),
                company: String(parsed.currentCompany || '').trim(),
              }
            }
          }
        } catch (extractErr: any) {
          console.error(`[LinkedIn Gemini Search] Extraction error: ${extractErr.message}`)
        }
      }
    }

    console.log(`[LinkedIn Gemini Search] Found ${allUrls.length} URLs, intel: ${intel ? `${intel.title} @ ${intel.company}` : 'none'}`)

    return { urls: [...new Set(allUrls)], intel }
  } catch (e: any) {
    console.error(`[LinkedIn Gemini Search] Error: ${e.message}`)
    return { urls: [], intel: null }
  }
}

// ---- Find LinkedIn profile for a HubSpot contact ----
// Strategy: Gemini Google Search grounding (search + intel) → slug probing → DuckDuckGo
// Gemini intel is used to enrich data when LinkedIn pages block direct scraping.

export async function findLinkedInForContact(contact: any): Promise<{
  profileUrl: string; name: string; title: string; company: string; confidence: number
} | null> {
  const firstName = safeText(contact.properties?.firstname)
  const lastName = safeText(contact.properties?.lastname)
  const fullName = `${firstName} ${lastName}`.trim()
  const firstLower = firstName.toLowerCase()
  const lastLower = lastName.toLowerCase()
  const company = safeText(contact.properties?.company)
  const title = safeText(contact.properties?.jobtitle)

  if (!firstName || !lastName) return null

  // Step 1: Gemini Google Search grounding — get URLs AND intel about the person
  const geminiResult = await searchLinkedInWithGemini(fullName, company, title)
  const geminiIntel = geminiResult.intel // May contain real company/title from Google's index
  let probeHit: ProbeResult | null = null
  let profileUrl = ''

  // Try to probe Gemini's URLs
  if (geminiResult.urls.length > 0) {
    for (const url of geminiResult.urls.slice(0, 3)) {
      const normalized = normalizeProfileUrl(url)
      if (!normalized) continue
      const result = await probeLinkedInUrl(normalized)
      if (result) {
        const titleLower = result.pageTitle.toLowerCase()
        if (titleLower.includes(firstLower) || titleLower.includes(lastLower)) {
          console.log(`[LinkedIn Discovery] Gemini+Probe HIT: ${normalized} → "${result.pageTitle}"`)
          probeHit = result
          profileUrl = normalized
          break
        }
      }
    }
    // Even if probing was blocked, keep the first URL for reference
    if (!profileUrl && geminiResult.urls.length > 0) {
      profileUrl = normalizeProfileUrl(geminiResult.urls[0]) || geminiResult.urls[0]
    }
  }

  // Step 2: Slug probing fallback
  if (!probeHit) {
    const candidateSlugs = [
      `${firstLower}-${lastLower}`,
      `${firstLower}${lastLower}`,
      `${lastLower}-${firstLower}`,
    ]

    for (const slug of candidateSlugs) {
      const candidateUrl = `https://www.linkedin.com/in/${slug}`
      const result = await probeLinkedInUrl(candidateUrl)
      if (result) {
        const pageTitleLower = result.pageTitle.toLowerCase()
        if (pageTitleLower.includes(firstLower) && pageTitleLower.includes(lastLower)) {
          console.log(`[LinkedIn Discovery] Slug probe HIT: ${candidateUrl} → "${result.pageTitle}"`)
          probeHit = result
          if (!profileUrl) profileUrl = candidateUrl
          break
        }
      }
    }
  }

  // Step 3: DuckDuckGo fallback
  if (!probeHit && !profileUrl) {
    const query = `${fullName} ${company} site:linkedin.com/in`
    try {
      const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const response = await fetch(searchUrl, { headers: { 'User-Agent': BROWSER_UA } })
      if (response.ok) {
        const html = await response.text()
        const urls = extractLinkedinProfileUrls(html)
        console.log(`[LinkedIn Discovery] DuckDuckGo found ${urls.length} URLs for "${fullName}"`)

        for (const url of urls.slice(0, 3)) {
          const normalized = normalizeProfileUrl(url)
          if (!normalized) continue
          const result = await probeLinkedInUrl(normalized)
          if (result) {
            const pageTitleLower = result.pageTitle.toLowerCase()
            if (pageTitleLower.includes(firstLower) || pageTitleLower.includes(lastLower)) {
              console.log(`[LinkedIn Discovery] DuckDuckGo probe HIT: ${normalized} → "${result.pageTitle}"`)
              probeHit = result
              profileUrl = normalized
              break
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  // If we have neither a probe hit, a URL, nor Gemini intel — give up
  if (!probeHit && !profileUrl && !geminiIntel) {
    console.log(`[LinkedIn Discovery] No profile found for ${fullName}`)
    return null
  }

  // Step 4: Build result — merge probe data with Gemini intel
  // Gemini intel (from Google's index) is more reliable than LinkedIn's limited public page
  let discoveredCompany = ''
  let discoveredTitle = ''
  let discoveredName = fullName

  if (probeHit) {
    const parsed = parseLinkedinTitlePage(probeHit.pageTitle)
    const inferredTitle = extractJobTitleFromMeta(probeHit.metaDescription)
    const aiData = await aiExtractProfileData(probeHit.pageTitle, probeHit.metaDescription, probeHit.url)

    discoveredName = aiData?.name || parsed.name || fullName
    discoveredCompany = aiData?.company || parsed.company || ''
    discoveredTitle = aiData?.title || inferredTitle || ''
  }

  // Gemini intel overrides if the probe data looks like location/generic text
  // (LinkedIn public pages often show "Location | Professional Profile" instead of company)
  // Also overrides when probe found a DIFFERENT person (common name edge case):
  //   probe company ≠ Gemini company AND probe company ≠ HubSpot company → wrong person
  if (geminiIntel) {
    const probeCompanyLooksWrong = !discoveredCompany ||
      discoveredCompany.toLowerCase().includes('professional profile') ||
      discoveredCompany.toLowerCase().includes('united states') ||
      discoveredCompany.toLowerCase().includes('linkedin')
    const probeTitleEmpty = !discoveredTitle

    // Common name edge case: probe found a real person, but it's the WRONG person
    // Gemini (via Google Search) knows the real company, and probe found a different one
    // that also doesn't match HubSpot → almost certainly a different person with the same name
    const probeCompanyConflictsWithGemini = geminiIntel.company &&
      discoveredCompany &&
      !probeCompanyLooksWrong &&
      discoveredCompany.toLowerCase() !== geminiIntel.company.toLowerCase() &&
      discoveredCompany.toLowerCase() !== company.toLowerCase()

    if ((probeCompanyLooksWrong || probeCompanyConflictsWithGemini) && geminiIntel.company) {
      if (probeCompanyConflictsWithGemini) {
        console.log(`[LinkedIn Discovery] Probe found "${discoveredCompany}" but Gemini says "${geminiIntel.company}" (HubSpot: "${company}") — likely wrong person, using Gemini intel`)
      }
      discoveredCompany = geminiIntel.company
      console.log(`[LinkedIn Discovery] Using Gemini intel for company: "${geminiIntel.company}"`)
    }
    if ((probeTitleEmpty || probeCompanyConflictsWithGemini) && geminiIntel.title) {
      discoveredTitle = geminiIntel.title
      console.log(`[LinkedIn Discovery] Using Gemini intel for title: "${geminiIntel.title}"`)
    }
  }

  // Probe validation: if the probe found a company that doesn't match HubSpot AND we have
  // no Gemini intel to say otherwise, this is likely a different person with the same name.
  // Reject the probe hit entirely — better to return not_found than wrong data.
  if (discoveredCompany && company && !geminiIntel) {
    const companyMatch = discoveredCompany.toLowerCase().includes(company.toLowerCase()) ||
                         company.toLowerCase().includes(discoveredCompany.toLowerCase())
    if (!companyMatch) {
      console.log(`[LinkedIn Discovery] Probe found "${discoveredCompany}" but HubSpot says "${company}" — no Gemini intel to corroborate, rejecting as likely wrong person`)
      return null
    }
  }

  // Calculate confidence
  let confidence = 0.5
  if (discoveredCompany && company) {
    const companyMatch = discoveredCompany.toLowerCase().includes(company.toLowerCase()) ||
                         company.toLowerCase().includes(discoveredCompany.toLowerCase())
    confidence = companyMatch ? 0.9 : 0.6
  }
  // Lower confidence only if we have no URL AND no Gemini intel
  if (!probeHit && !profileUrl && !geminiIntel) confidence = Math.min(confidence, 0.4)

  console.log(`[LinkedIn Discovery] ${fullName}: url="${profileUrl}" company="${discoveredCompany}" title="${discoveredTitle}" confidence=${confidence}`)

  return {
    profileUrl: profileUrl || '',
    name: discoveredName,
    title: discoveredTitle,
    company: discoveredCompany,
    confidence,
  }
}

// Keep these exports for backward compatibility with agent.routes.ts
export async function toolSearchWeb(query: string): Promise<string> {
  return JSON.stringify({ linkedinUrls: [], source: 'deprecated' })
}

export async function toolFetchLinkedInPage(url: string): Promise<string> {
  const result = await probeLinkedInUrl(normalizeProfileUrl(url) || url)
  if (!result) return 'Fetch failed'
  return JSON.stringify(result)
}

export const LINKEDIN_TOOL_DECLARATIONS = [
  {
    name: 'search_web',
    description: 'Search for LinkedIn profiles.',
    parametersJsonSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'fetch_linkedin_page',
    description: 'Fetch a LinkedIn profile page.',
    parametersJsonSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  }
]

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
