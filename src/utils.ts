import { readFileSync } from 'fs'
import { join } from 'path'
import { C_SUITE_KEYWORDS, TARGET_SECTORS, type LeadSector } from './config.js'

// ---- File loading ----

export function loadJsonArray(relativePath: string, label: string): any[] {
  try {
    const filePath = join(process.cwd(), 'src', relativePath)
    const data = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(data)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    console.error(`Error loading ${label}:`, e)
    return []
  }
}

// ---- Lead normalization ----

export function normalizeLinkedinLead(lead: any) {
  const normalizedCompany = lead.company || lead.companyName || ''
  const normalizedCompanyWebsite = lead.companyWebsite || lead.website || ''
  const normalizedProfileUrl = lead.profileUrl || lead.url || ''
  const normalizedEmail = lead.email || (Array.isArray(lead.emails) ? lead.emails[0] : undefined)

  return {
    ...lead,
    profileUrl: normalizedProfileUrl,
    url: lead.url || normalizedProfileUrl,
    company: normalizedCompany,
    companyName: lead.companyName || normalizedCompany,
    companyWebsite: normalizedCompanyWebsite,
    email: normalizedEmail,
  }
}

export function getLeadIdentityKey(lead: any) {
  return (
    lead.profileUrl ||
    lead.url ||
    lead.email ||
    lead.name ||
    JSON.stringify(lead)
  ).toLowerCase()
}

// ---- URL normalization ----

export function normalizeProfileUrl(rawUrl?: string) {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  try {
    const parsed = new URL(rawUrl.trim())
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
    const normalizedPath = parsed.pathname.replace(/\/$/, '').toLowerCase()
    return `${parsed.protocol}//${host}${normalizedPath}`
  } catch {
    return rawUrl.trim().toLowerCase().replace(/\/$/, '')
  }
}

export function toStableIdentifier(candidate: any) {
  const normalizedUrl = normalizeProfileUrl(candidate.profileUrl || candidate.url || candidate.provenance?.sourceUrl)
  return (normalizedUrl || candidate.email || candidate.name || '').toLowerCase().trim()
}

// ---- Text utilities ----

export function safeText(value: any) {
  return typeof value === 'string' ? value.trim() : ''
}

// ---- Domain inference ----

export function inferSector(input?: string): LeadSector {
  if (!input) return 'unknown'
  const value = input.toLowerCase()
  if (value.includes('real estate') || value.includes('property')) return 'real_estate'
  if (value.includes('retail tech') || value.includes('commerce tech')) return 'retail_tech'
  if (value.includes('commerce') || value.includes('ecommerce') || value.includes('e-commerce')) return 'commerce'
  if (value.includes('retail')) return 'retail'
  return 'unknown'
}

export function isCSuiteTitle(title?: string) {
  if (!title) return false
  const normalized = title.toLowerCase()
  return C_SUITE_KEYWORDS.some(keyword => normalized.includes(keyword))
}

// ---- Deduplication ----

export function dedupeByIdentifier<T extends { identifier: string }>(items: T[]) {
  const map = new Map<string, T>()
  for (const item of items) {
    if (!item.identifier) continue
    if (!map.has(item.identifier)) {
      map.set(item.identifier, item)
    }
  }
  return Array.from(map.values())
}

// ---- LinkedIn HTML parsing ----

export function extractLinkedinProfileUrls(html: string) {
  const profileRegex = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?/g
  const directMatches = html.match(profileRegex) || []
  const decodedMatches: string[] = []

  const encodedRegex = /uddg=([^&"'\s]+)/g
  let encodedMatch: RegExpExecArray | null = null
  while ((encodedMatch = encodedRegex.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(encodedMatch[1])
      if (/linkedin\.com\/in\//i.test(decoded)) {
        decodedMatches.push(decoded)
      }
    } catch {
      // ignore malformed URI segments
    }
  }

  const all = [...directMatches, ...decodedMatches]
  return Array.from(new Set(all.map(normalizeProfileUrl).filter(url => /linkedin\.com\/in\//.test(url))))
}

export function parseLinkedinTitlePage(titleText: string) {
  // LinkedIn page title format: "Name - Company | LinkedIn"
  const withoutSuffix = titleText.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim()
  const parts = withoutSuffix.split(' - ').map(p => p.trim()).filter(Boolean)
  const name = parts[0] || ''
  const company = parts.slice(1).join(' - ').trim()
  return { name, title: '', company }
}

export function extractJobTitleFromMeta(metaDescription: string): string {
  if (!metaDescription) return ''

  // Pattern 1: "Name\nTitle | Description..." — the second line is often the title
  const lines = metaDescription.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length >= 2) {
    const candidateLine = lines[1].split('|')[0].trim()
    if (candidateLine.length > 0 && candidateLine.length < 120) return candidateLine
  }

  // Pattern 2: Explicit C-suite keyword anywhere in the description
  const csuitePattern = /\b(CEO|COO|CTO|CFO|CRO|CMO|CIO|Chief\s+[\w\s]+Officer|President|Founder|Co-?Founder|Managing\s+Director|Executive\s+Director|Operations\s+Director|General\s+Manager)\b/i
  const m = metaDescription.match(csuitePattern)
  if (m) return m[0].trim()

  return ''
}

// ---- Confidence scoring ----

export function deriveConfidence(signals: { titleMatch: boolean, sectorMatch: boolean, companyMatch: boolean }, hasName: boolean, hasPublicSource: boolean) {
  let score = 0.2
  if (signals.titleMatch) score += 0.35
  if (signals.sectorMatch) score += 0.2
  if (signals.companyMatch) score += 0.15
  if (hasName) score += 0.1
  if (hasPublicSource) score += 0.1
  return Math.max(0, Math.min(1, Number(score.toFixed(2))))
}

// ---- Error formatting ----

export function apiError(code: string, message: string, details?: any) {
  return { error: { code, message, details: details || null } }
}
