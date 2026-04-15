import { TARGET_SECTORS, type LeadSector, CRAWL_COOLDOWN_MS } from '../config.js'
import { normalizeProfileUrl } from '../utils.js'
import { CrawlAttempt } from '../db.js'
import mongoose from 'mongoose'

// Re-exported from linkedin.service so agent routes don't need to import from two places
export { recordCrawlAttempt, shouldSkipDueToCooldown } from '../services/linkedin.service.js'

export function buildSectorCompanyQueries(companies: string[] = [], sectors: LeadSector[] = TARGET_SECTORS, titles: string[] = ['CEO', 'COO', 'CRO', 'CTO']) {
  const effectiveCompanies = companies.filter(Boolean)
  const effectiveSectors = sectors.length ? sectors : TARGET_SECTORS
  const queries: string[] = []

  if (effectiveCompanies.length > 0) {
    for (const company of effectiveCompanies) {
      for (const title of titles) {
        queries.push(`site:linkedin.com/in "${title}" "${company}"`)
        queries.push(`linkedin.com/in "${title}" "${company}"`)
      }
    }
  } else {
    const sectorLabels: Record<LeadSector, string[]> = {
      retail: ['retail', 'consumer goods'],
      real_estate: ['real estate', 'property'],
      retail_tech: ['retail tech', 'commerce technology'],
      commerce: ['ecommerce', 'e-commerce', 'commerce'],
      unknown: [],
    }
    for (const sector of effectiveSectors) {
      const labels = sectorLabels[sector] || [sector.replace('_', ' ')]
      for (const label of labels.slice(0, 1)) {
        for (const title of titles) {
          queries.push(`site:linkedin.com/in "${title}" "${label}"`)
          queries.push(`linkedin "${title}" "${label}" site:linkedin.com`)
        }
      }
    }
  }

  return queries
}
