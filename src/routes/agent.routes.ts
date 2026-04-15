import { Hono } from 'hono'
import { AGENT_MIN_CONFIDENCE, MAX_AGENT_RESULTS, TARGET_SECTORS, type LeadSector } from '../config.js'
import {
  normalizeProfileUrl, safeText, inferSector, isCSuiteTitle,
  dedupeByIdentifier, toStableIdentifier, extractLinkedinProfileUrls,
  parseLinkedinTitlePage, extractJobTitleFromMeta, deriveConfidence, apiError,
  getLeadIdentityKey
} from '../utils.js'
import { AgentLead } from '../db.js'
import { recordCrawlAttempt, shouldSkipDueToCooldown, buildSectorCompanyQueries } from './agent.helpers.js'
import { findLinkedInForContact } from '../services/linkedin.service.js'
import { aiExtractProfileSignals } from '../services/ai.service.js'
import { getLeads } from './leads.routes.js'
import mongoose from 'mongoose'

const agentRoutes = new Hono()

// ---- Helper: build sector/company queries ----
// (exported from a helper so we don't circular-import)

// ---- Search Public Profiles ----

agentRoutes.post('/api/agent/search-public-profiles', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const companies = Array.isArray(body.companies) ? body.companies.map((v: any) => safeText(v)).filter(Boolean) : []
    const sectorsInput = Array.isArray(body.sectors) ? body.sectors.map((v: any) => inferSector(String(v))) : TARGET_SECTORS
    const sectors = sectorsInput.filter((v: LeadSector) => [...TARGET_SECTORS, 'unknown'].includes(v))
    const titles = Array.isArray(body.titles) ? body.titles.map((v: any) => safeText(v)).filter(Boolean) : ['CEO', 'COO', 'CRO', 'CTO']
    const limit = Math.min(Number(body.limit || 20), MAX_AGENT_RESULTS)
    const seedProfileUrls = Array.isArray(body.seedProfileUrls) ? body.seedProfileUrls.map((v: any) => normalizeProfileUrl(String(v))).filter(Boolean) : []

    if (Number.isNaN(limit) || limit <= 0) {
      return c.json(apiError('INVALID_INPUT', 'limit must be a positive number'), 400)
    }

    const queries = buildSectorCompanyQueries(companies, sectors, titles)
    const discoveredUrls = new Set<string>(seedProfileUrls.filter((url: string) => /linkedin\.com\/in\//.test(url)))

    for (const query of queries.slice(0, 20)) {
      if (discoveredUrls.size >= limit) break
      const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const normalizedSearchUrl = normalizeProfileUrl(searchUrl)
      if (await shouldSkipDueToCooldown(normalizedSearchUrl)) {
        await recordCrawlAttempt({ url: searchUrl, normalizedUrl: normalizedSearchUrl, query, status: 'skipped', reason: 'cooldown-window-active' })
        continue
      }

      try {
        const response = await fetch(searchUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
        })

        if (!response.ok) {
          const statusType = response.status === 403 || response.status === 429 ? 'blocked' : 'failed'
          await recordCrawlAttempt({ url: searchUrl, normalizedUrl: normalizedSearchUrl, query, status: statusType, reason: `search-http-${response.status}`, responseStatus: response.status })
          continue
        }

        const html = await response.text()
        const urls = extractLinkedinProfileUrls(html)
        for (const url of urls) {
          if (discoveredUrls.size >= limit) break
          discoveredUrls.add(url)
        }
        await recordCrawlAttempt({ url: searchUrl, normalizedUrl: normalizedSearchUrl, query, status: 'success', responseStatus: response.status })
      } catch (error: any) {
        await recordCrawlAttempt({ url: searchUrl, normalizedUrl: normalizedSearchUrl, query, status: 'failed', reason: error?.message || 'search-fetch-failed' })
      }
    }

    // Bing fallback
    if (discoveredUrls.size === 0) {
      for (const query of queries.slice(0, 10)) {
        if (discoveredUrls.size >= limit) break
        const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
        const normalizedBingUrl = normalizeProfileUrl(bingUrl)
        try {
          const response = await fetch(bingUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
          })
          if (response.ok) {
            const html = await response.text()
            const urls = extractLinkedinProfileUrls(html)
            for (const url of urls) {
              if (discoveredUrls.size >= limit) break
              discoveredUrls.add(url)
            }
            await recordCrawlAttempt({ url: bingUrl, normalizedUrl: normalizedBingUrl, query, status: 'success', responseStatus: response.status })
          }
        } catch (error: any) {
          await recordCrawlAttempt({ url: bingUrl, normalizedUrl: normalizedBingUrl, query, status: 'failed', reason: error?.message || 'bing-fetch-failed' })
        }
      }
    }

    // Bootstrap fallback
    const leads = getLeads()
    let usedBootstrapFallback = false
    if (discoveredUrls.size === 0 && leads.length > 0) {
      usedBootstrapFallback = true
      for (const lead of leads) {
        const normalized = normalizeProfileUrl(lead.profileUrl || lead.url)
        if (!normalized || !/linkedin\.com\/in\//.test(normalized)) continue
        discoveredUrls.add(normalized)
        if (discoveredUrls.size >= limit) break
      }
    }

    const candidates = Array.from(discoveredUrls).slice(0, limit).map((profileUrl) => {
      const identifier = toStableIdentifier({ profileUrl })
      return {
        identifier,
        profileUrl,
        sector: 'unknown' as LeadSector,
        isCSuite: false,
        confidence: 0,
        provenance: {
          sourceUrl: profileUrl,
          fetchedAt: new Date().toISOString(),
          method: usedBootstrapFallback ? 'bootstrap-linkedin-json' : 'public-search'
        },
        signals: { titleMatch: false, sectorMatch: false, companyMatch: false }
      }
    })

    return c.json({ queries, total: candidates.length, usedBootstrapFallback, candidates })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to search public profiles', error?.message), 500)
  }
})

// ---- Extract Profile Signals ----

agentRoutes.post('/api/agent/extract-profile-signals', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const profiles = Array.isArray(body.profiles) ? body.profiles : []
    if (!profiles.length) return c.json(apiError('INVALID_INPUT', 'profiles array is required'), 400)

    const extracted: any[] = []

    for (const profile of profiles.slice(0, MAX_AGENT_RESULTS)) {
      const sourceUrl = normalizeProfileUrl(profile.profileUrl || profile.url)
      const expectedCompany = safeText(profile.company)
      const expectedSector = inferSector(profile.sector || '')

      if (!sourceUrl) {
        extracted.push({
          identifier: '', name: safeText(profile.name), title: safeText(profile.title),
          company: expectedCompany, sector: expectedSector, isCSuite: false, confidence: 0,
          provenance: { sourceUrl: '', fetchedAt: new Date().toISOString(), method: 'invalid-input' },
          signals: { titleMatch: false, sectorMatch: false, companyMatch: false },
          insufficientPublicData: true
        })
        continue
      }

      if (await shouldSkipDueToCooldown(sourceUrl)) {
        await recordCrawlAttempt({ url: sourceUrl, normalizedUrl: sourceUrl, status: 'skipped', reason: 'cooldown-window-active' })
      }

      let pageTitle = ''
      let metaDescription = ''
      let fetchMethod = 'public-profile-fetch'

      try {
        const response = await fetch(sourceUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadIntakeBot/1.0; +https://coresight.com)' }
        })

        if (!response.ok) {
          const statusType = response.status === 403 || response.status === 429 ? 'blocked' : 'failed'
          await recordCrawlAttempt({ url: sourceUrl, normalizedUrl: sourceUrl, status: statusType, reason: `profile-http-${response.status}`, responseStatus: response.status })
        } else {
          const html = await response.text()
          const titleMatch = html.match(/<title>(.*?)<\/title>/i)
          const descriptionMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i)
          pageTitle = safeText(titleMatch?.[1] || '')
          metaDescription = safeText(descriptionMatch?.[1] || '')
          await recordCrawlAttempt({ url: sourceUrl, normalizedUrl: sourceUrl, status: 'success', responseStatus: response.status })
        }
      } catch (error: any) {
        fetchMethod = 'public-profile-fetch-failed'
        await recordCrawlAttempt({ url: sourceUrl, normalizedUrl: sourceUrl, status: 'failed', reason: error?.message || 'profile-fetch-failed' })
      }

      const parsed = parseLinkedinTitlePage(pageTitle)
      const metaTitle = extractJobTitleFromMeta(metaDescription)

      let name = safeText(profile.name) || parsed.name
      let title = safeText(profile.title) || metaTitle
      let company = expectedCompany || parsed.company

      let aiResult: Awaited<ReturnType<typeof aiExtractProfileSignals>> = null
      if ((!title || !company || !name) && (pageTitle || metaDescription)) {
        aiResult = await aiExtractProfileSignals(pageTitle, metaDescription, sourceUrl)
        if (aiResult) {
          name = name || aiResult.name
          title = title || aiResult.title
          company = company || aiResult.company
        }
      }

      const sector = aiResult?.sector !== 'unknown' && aiResult?.sector
        ? aiResult.sector as LeadSector
        : inferSector(profile.sector || `${company} ${title} ${metaDescription}`)

      const titleMatch = Boolean(aiResult?.isCSuite) || isCSuiteTitle(title)
      const sectorMatch = expectedSector === 'unknown' ? sector !== 'unknown' : sector === expectedSector
      const companyMatch = expectedCompany ? company.toLowerCase().includes(expectedCompany.toLowerCase()) : !!company
      const confidence = deriveConfidence({ titleMatch, sectorMatch, companyMatch }, !!name, !!sourceUrl)

      extracted.push({
        identifier: toStableIdentifier({ profileUrl: sourceUrl, name }),
        profileUrl: sourceUrl, name, title, company, sector,
        isCSuite: titleMatch, confidence,
        provenance: { sourceUrl, fetchedAt: new Date().toISOString(), method: fetchMethod },
        signals: { titleMatch, sectorMatch, companyMatch },
        insufficientPublicData: confidence < AGENT_MIN_CONFIDENCE,
        raw: { pageTitle, metaDescription }
      })
    }

    const deduped = dedupeByIdentifier(extracted.filter(candidate => candidate.identifier))
    return c.json({ total: deduped.length, threshold: AGENT_MIN_CONFIDENCE, candidates: deduped })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to extract profile signals', error?.message), 500)
  }
})

// ---- AI Enrich Profiles ----

agentRoutes.post('/api/agent/ai-enrich-profiles', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const profiles = Array.isArray(body.profiles) ? body.profiles : []
    if (!profiles.length) return c.json(apiError('INVALID_INPUT', 'profiles array is required'), 400)

    const enriched: any[] = []

    for (const profile of profiles.slice(0, MAX_AGENT_RESULTS)) {
      const pageTitle = safeText(profile.raw?.pageTitle || profile.pageTitle)
      const metaDescription = safeText(profile.raw?.metaDescription || profile.metaDescription)
      const profileUrl = normalizeProfileUrl(profile.profileUrl || profile.url || profile.identifier)

      const existingTitle = safeText(profile.title)
      const existingName = safeText(profile.name)
      const existingCompany = safeText(profile.company)

      let name = existingName
      let title = existingTitle || extractJobTitleFromMeta(metaDescription)
      let company = existingCompany || parseLinkedinTitlePage(pageTitle).company
      let sector = inferSector(profile.sector || `${company} ${title} ${metaDescription}`)
      let isCSuiteVal = isCSuiteTitle(title)

      if (!title || !company || !name) {
        const aiResult = await aiExtractProfileSignals(pageTitle, metaDescription, profileUrl)
        if (aiResult) {
          name = name || aiResult.name
          title = title || aiResult.title
          company = company || aiResult.company
          if (aiResult.sector !== 'unknown') sector = aiResult.sector as LeadSector
          isCSuiteVal = isCSuiteVal || aiResult.isCSuite
        }
      }

      const signals = {
        titleMatch: isCSuiteVal,
        sectorMatch: TARGET_SECTORS.includes(sector as any),
        companyMatch: !!company,
      }
      const confidence = deriveConfidence(signals, !!name, !!profileUrl)

      enriched.push({
        ...profile,
        identifier: profileUrl || profile.identifier,
        profileUrl, name, title, company, sector,
        isCSuite: isCSuiteVal, confidence, signals,
        insufficientPublicData: confidence < AGENT_MIN_CONFIDENCE,
      })
    }

    return c.json({
      threshold: AGENT_MIN_CONFIDENCE,
      total: enriched.length,
      accepted: enriched.filter(e => !e.insufficientPublicData).length,
      candidates: enriched,
    })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to ai-enrich profiles', error?.message), 500)
  }
})

// ---- Rank C-Suite Targets ----

agentRoutes.post('/api/agent/rank-csuite-targets', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const candidates = Array.isArray(body.candidates) ? body.candidates : []
    const threshold = typeof body.minConfidence === 'number' ? body.minConfidence : AGENT_MIN_CONFIDENCE

    if (!candidates.length) return c.json(apiError('INVALID_INPUT', 'candidates array is required'), 400)

    const ranked = candidates.map((candidate: any) => {
      const confidence = Number(candidate.confidence || 0)
      const titleMatch = Boolean(candidate.signals?.titleMatch || isCSuiteTitle(candidate.title))
      const sector = inferSector(candidate.sector)
      const sectorMatch = TARGET_SECTORS.includes(sector as any)
      const score = Number((confidence + (titleMatch ? 0.2 : 0) + (sectorMatch ? 0.1 : 0) + (candidate.signals?.companyMatch ? 0.05 : 0)).toFixed(3))
      const accept = score >= threshold && titleMatch

      return { ...candidate, sector, isCSuite: titleMatch, score, accept, decision: accept ? 'accept' : 'insufficient_public_data' }
    }).sort((a: any, b: any) => b.score - a.score)

    return c.json({
      threshold,
      total: ranked.length,
      accepted: ranked.filter((item: any) => item.accept).length,
      rejected: ranked.filter((item: any) => !item.accept).length,
      candidates: ranked
    })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to rank csuite targets', error?.message), 500)
  }
})

// ---- Save Candidates ----

agentRoutes.post('/api/agent/save-candidates', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const candidates = Array.isArray(body.candidates) ? body.candidates : []
    const threshold = typeof body.minConfidence === 'number' ? body.minConfidence : AGENT_MIN_CONFIDENCE

    if (!candidates.length) return c.json(apiError('INVALID_INPUT', 'candidates array is required'), 400)

    const accepted: any[] = []
    const rejected: any[] = []
    const leads = getLeads()

    for (const candidate of candidates.slice(0, MAX_AGENT_RESULTS)) {
      const identifier = toStableIdentifier(candidate)
      const profileUrl = normalizeProfileUrl(candidate.profileUrl || candidate.provenance?.sourceUrl || candidate.url)
      const confidence = Number(candidate.confidence || 0)
      const sector = inferSector(candidate.sector)
      const normalizedCandidate = {
        identifier, profileUrl,
        name: safeText(candidate.name),
        title: safeText(candidate.title),
        company: safeText(candidate.company),
        sector,
        isCSuite: Boolean(candidate.isCSuite ?? isCSuiteTitle(candidate.title)),
        confidence,
        provenance: {
          sourceUrl: profileUrl || safeText(candidate.provenance?.sourceUrl),
          fetchedAt: candidate.provenance?.fetchedAt ? new Date(candidate.provenance.fetchedAt) : new Date(),
          method: safeText(candidate.provenance?.method) || 'agent-intake'
        },
        signals: {
          titleMatch: Boolean(candidate.signals?.titleMatch || isCSuiteTitle(candidate.title)),
          sectorMatch: Boolean(candidate.signals?.sectorMatch || TARGET_SECTORS.includes(sector as any)),
          companyMatch: Boolean(candidate.signals?.companyMatch || !!safeText(candidate.company))
        },
        raw: candidate.raw || null
      }

      if (!normalizedCandidate.identifier || !normalizedCandidate.provenance.sourceUrl) {
        rejected.push({ identifier: normalizedCandidate.identifier || '', reason: 'missing_identifier_or_source' })
        continue
      }
      if (normalizedCandidate.confidence < threshold) {
        rejected.push({ identifier: normalizedCandidate.identifier, reason: 'insufficient_public_data' })
        continue
      }

      if (mongoose.connection.readyState === 1) {
        await AgentLead.findOneAndUpdate(
          { identifier: normalizedCandidate.identifier },
          normalizedCandidate,
          { upsert: true, new: true }
        )
      }

      const leadShape = {
        profileUrl: normalizedCandidate.profileUrl,
        url: normalizedCandidate.profileUrl,
        name: normalizedCandidate.name,
        title: normalizedCandidate.title,
        company: normalizedCandidate.company,
        isCSuite: normalizedCandidate.isCSuite,
        contextForAI: `Signals: ${JSON.stringify(normalizedCandidate.signals)} | Provenance: ${normalizedCandidate.provenance.sourceUrl}`,
        confidence: normalizedCandidate.confidence,
        provenance: {
          sourceUrl: normalizedCandidate.provenance.sourceUrl,
          fetchedAt: normalizedCandidate.provenance.fetchedAt,
          method: normalizedCandidate.provenance.method
        }
      }

      const existingIndex = leads.findIndex(lead => getLeadIdentityKey(lead) === normalizedCandidate.identifier)
      if (existingIndex >= 0) {
        leads[existingIndex] = { ...leads[existingIndex], ...leadShape }
      } else {
        leads.push(leadShape)
      }

      accepted.push({ identifier: normalizedCandidate.identifier, confidence: normalizedCandidate.confidence })
    }

    return c.json({
      threshold,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      accepted,
      rejected,
      note: rejected.some(item => item.reason === 'insufficient_public_data') ? 'insufficient public data guardrail applied' : undefined
    })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to save candidates', error?.message), 500)
  }
})

// ---- HubSpot → LinkedIn Agent ----

agentRoutes.post('/api/agent/hubspot-to-linkedin', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const limit = Math.min(Number(body.limit || 10), 25)
    const after = body.after ? String(body.after) : undefined

    if (!process.env.GEMINI_API_KEY) return c.json(apiError('CONFIG_ERROR', 'GEMINI_API_KEY is not set'), 500)
    if (!process.env.HUBSPOT_TOKEN) return c.json(apiError('CONFIG_ERROR', 'HUBSPOT_TOKEN is not set'), 500)

    const hsUrl = new URL('https://api.hubapi.com/crm/v3/objects/contacts')
    hsUrl.searchParams.set('limit', String(limit))
    for (const prop of ['firstname', 'lastname', 'email', 'company', 'jobtitle', 'industry', 'notes_last_activity_date']) {
      hsUrl.searchParams.append('properties', prop)
    }
    if (after) hsUrl.searchParams.set('after', after)

    const hsRes = await fetch(hsUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' }
    })

    if (!hsRes.ok) {
      const errText = await hsRes.text()
      return c.json(apiError('HUBSPOT_ERROR', `HubSpot API returned ${hsRes.status}`, errText), 502)
    }

    const hsData = await hsRes.json()
    const allContacts: any[] = hsData.results || []
    const nextCursor: string | undefined = hsData.paging?.next?.after

    const eligible = allContacts.filter(ct => {
      const hasName = safeText(ct.properties?.firstname) || safeText(ct.properties?.lastname)
      const hasCompany = safeText(ct.properties?.company)
      return hasName && hasCompany
    })

    if (!eligible.length) {
      return c.json({
        processed: allContacts.length, eligible: 0, found: 0, notFound: 0,
        nextCursor: nextCursor || null,
        note: 'No contacts on this page had both a name and company. Try nextCursor to advance to the next page.',
        candidates: []
      })
    }

    const candidates: any[] = []
    let found = 0
    let notFound = 0

    for (const contact of eligible) {
      const firstName = safeText(contact.properties?.firstname)
      const lastName = safeText(contact.properties?.lastname)
      const name = `${firstName} ${lastName}`.trim()
      const company = safeText(contact.properties?.company)
      const title = safeText(contact.properties?.jobtitle)

      try {
        const result = await findLinkedInForContact(contact)

        if (result && result.profileUrl && result.confidence >= 0.4) {
          const identifier = toStableIdentifier({ profileUrl: result.profileUrl, name: result.name })
          const sector = inferSector(`${result.company} ${result.title}`)
          const signals = {
            titleMatch: isCSuiteTitle(result.title),
            sectorMatch: TARGET_SECTORS.includes(sector as LeadSector),
            companyMatch: !!result.company
          }

          candidates.push({
            identifier,
            profileUrl: result.profileUrl,
            name: result.name || name,
            title: result.title || title,
            company: result.company || company,
            sector,
            isCSuite: signals.titleMatch,
            confidence: deriveConfidence(signals, !!result.name, true),
            provenance: { sourceUrl: result.profileUrl, fetchedAt: new Date().toISOString(), method: 'hubspot-to-linkedin-agent' },
            signals,
            hubspotId: contact.id,
            hubspotEmail: safeText(contact.properties?.email)
          })
          found++
        } else {
          notFound++
          console.log(`[hubspot-to-linkedin] No LinkedIn found for: ${name} @ ${company}`)
        }
      } catch (err: any) {
        console.error(`[hubspot-to-linkedin] Error for ${name}:`, err.message)
        notFound++
      }
    }

    return c.json({
      processed: allContacts.length,
      eligible: eligible.length,
      found, notFound,
      nextCursor: nextCursor || null,
      note: 'Pipe candidates into POST /api/agent/rank-csuite-targets then POST /api/agent/save-candidates. Pass nextCursor as "after" to process the next page.',
      candidates
    })
  } catch (error: any) {
    return c.json(apiError('INTERNAL_ERROR', 'failed to run hubspot-to-linkedin agent', error?.message), 500)
  }
})

export default agentRoutes
