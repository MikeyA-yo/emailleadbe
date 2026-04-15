import { Hono } from 'hono'
import { loadJsonArray, normalizeLinkedinLead, getLeadIdentityKey } from '../utils.js'

// ---- Load and merge lead sources (LinkedIn-first precedence) ----

const baseLeads = loadJsonArray('leads.json', 'leads.json')
const linkedinLeadsRaw = loadJsonArray('linkedin.json', 'linkedin.json')
const linkedinLeads = linkedinLeadsRaw.map(normalizeLinkedinLead)

const leadMap = new Map<string, any>()
for (const lead of linkedinLeads) {
  leadMap.set(getLeadIdentityKey(lead), lead)
}
for (const lead of baseLeads) {
  const key = getLeadIdentityKey(lead)
  if (!leadMap.has(key)) {
    leadMap.set(key, lead)
  }
}

export let leads: any[] = Array.from(leadMap.values())
console.log(`Loaded ${linkedinLeads.length} LinkedIn leads first, plus ${baseLeads.length} base leads (deduped)`)

// Expose for other modules to push new leads
export function getLeads() { return leads }
export function setLeads(newLeads: any[]) { leads = newLeads }

// ---- Routes ----

const leadsRoutes = new Hono()

leadsRoutes.get('/api/leads', (c) => {
  const search = c.req.query('search')
  let result = leads

  if (search) {
    const s = search.toLowerCase()
    result = leads.filter(l =>
      (l.name && l.name.toLowerCase().includes(s)) ||
      (l.title && l.title.toLowerCase().includes(s)) ||
      (l.company && l.company.toLowerCase().includes(s)) ||
      (l.email && l.email.toLowerCase().includes(s))
    )
  }

  return c.json(result)
})

export default leadsRoutes
