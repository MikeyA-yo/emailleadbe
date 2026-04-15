import { Hono } from 'hono'
import { AGENT_MIN_CONFIDENCE } from '../config.js'
import { normalizeProfileUrl, safeText, getLeadIdentityKey } from '../utils.js'
import { AgentLead, Group } from '../db.js'
import { generateEmailContent, generateBulkTemplate } from '../services/ai.service.js'
import { sendEmail, sendBulkEmails } from '../services/email.service.js'
import { getHubspotContacts } from '../services/hubspot.service.js'
import { getLeads } from './leads.routes.js'
import mongoose from 'mongoose'

const emailRoutes = new Hono()

// ---- Core email generation logic (shared by single + bulk) ----

async function generateEmailForLead(identifier: string, company?: string, context?: string) {
  const normalizedIdentifier = normalizeProfileUrl(identifier) || identifier.toLowerCase().trim()

  // Check agent leads first
  if (mongoose.connection.readyState === 1) {
    const persistedAgentLead = await AgentLead.findOne({
      $or: [
        { identifier: normalizedIdentifier },
        { profileUrl: normalizedIdentifier },
        { 'provenance.sourceUrl': normalizedIdentifier },
        { name: identifier }
      ]
    }).lean() as any

    if (persistedAgentLead) {
      if (persistedAgentLead.confidence < AGENT_MIN_CONFIDENCE) {
        throw new Error('Insufficient public data for this lead. Confidence below threshold; not eligible for email generation.')
      }

      return generateEmailContent({
        name: persistedAgentLead.name,
        title: persistedAgentLead.title,
        company: company || persistedAgentLead.company,
        sector: persistedAgentLead.sector,
        confidence: persistedAgentLead.confidence,
        signals: persistedAgentLead.signals,
        provenance: persistedAgentLead.provenance,
      }, context, false, true)
    }
  }

  // Find in regular leads
  const leads = getLeads()
  let lead = leads.find(l =>
    l.email === identifier ||
    l.profileUrl === identifier ||
    l.url === identifier ||
    l.name === identifier
  )

  if (lead && company) {
    lead.company = company
  }

  let isHubspotContact = false

  // If not found, search HubSpot
  if (!lead) {
    const hubspotContacts = getHubspotContacts()
    let hsContact = hubspotContacts.find((c: any) =>
      c.properties?.email === identifier ||
      c.id === identifier ||
      `${c.properties?.firstname || ''} ${c.properties?.lastname || ''}`.trim() === identifier
    )

    // Fetch from HubSpot API if not in cache
    if (!hsContact && process.env.HUBSPOT_TOKEN) {
      const ht = process.env.HUBSPOT_TOKEN
      const isEmail = identifier.includes('@')

      try {
        const idProp = isEmail ? '&idProperty=email' : ''
        const res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(identifier)}?properties=firstname,lastname,email,company,jobtitle,hs_email_last_open_date,hs_email_last_click_date,industry,notes_last_activity_date${idProp}`, {
          headers: { Authorization: `Bearer ${ht}` }
        })
        if (res.ok) hsContact = await res.json()
      } catch(e) { console.error("Error fetching contact by ID/Email", e) }

      if (!hsContact && !isEmail) {
        try {
          const searchBody = {
            query: identifier,
            limit: 1,
            properties: ["firstname", "lastname", "email", "company", "jobtitle", "hs_email_last_open_date", "hs_email_last_click_date", "industry", "notes_last_activity_date"]
          }
          const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
            method: "POST",
            headers: { Authorization: `Bearer ${ht}`, "Content-Type": "application/json" },
            body: JSON.stringify(searchBody)
          })
          if (res.ok) {
            const data = await res.json()
            if (data.results && data.results.length > 0) hsContact = data.results[0]
          }
        } catch(e) { console.error("Error searching contact by name", e) }
      }

      if (hsContact) {
        const exists = hubspotContacts.find((c: any) => c.id === hsContact.id)
        if (!exists) hubspotContacts.push(hsContact)
      }
    }

    if (hsContact) {
      isHubspotContact = true
      lead = {
        name: `${hsContact.properties?.firstname || ''} ${hsContact.properties?.lastname || ''}`.trim(),
        email: hsContact.properties?.email,
        company: company || hsContact.properties?.company || 'Unknown',
        title: hsContact.properties?.jobtitle || 'Unknown',
        contextForAI: 'This contact was imported from HubSpot. We have limited context about them.',
        about: 'N/A'
      }
    }
  }

  if (!lead) {
    throw new Error('Lead/Contact not found. Please provide a valid email, profileUrl, url, or name as identifier.')
  }

  return generateEmailContent(lead, context, isHubspotContact)
}

// ---- Generate email endpoint ----

emailRoutes.post('/api/generate-email', async (c) => {
  try {
    const { identifier, context, company } = await c.req.json()
    const result = await generateEmailForLead(identifier, company, context)

    return c.json({
      success: true,
      text: result.text,
      leadName: result.leadName
    })
  } catch (error: any) {
    console.error("Error generating email:", error)
    return c.json({ error: error.message || 'Failed to generate email' }, 500)
  }
})

// ---- Bulk generate emails ----

emailRoutes.post('/api/bulk-generate-email', async (c) => {
  try {
    const body = await c.req.json()
    const { groupId, identifiers, context } = body
    let targets: { identifier: string; name?: string; company?: string }[] = []

    if (groupId) {
      const group = await Group.findById(groupId)
      if (!group) return c.json({ error: 'Group not found' }, 404)
      targets = group.contacts.map((contact: any) => ({ identifier: contact.identifier, name: contact.name, company: contact.company }))
    } else if (Array.isArray(identifiers)) {
      targets = identifiers.map((id: any) => typeof id === 'string' ? { identifier: id } : id)
    } else {
      return c.json({ error: 'Must provide groupId or an array of identifiers' }, 400)
    }

    const templateText = await generateBulkTemplate(context)

    const leads = getLeads()
    const hubspotContacts = getHubspotContacts()

    const generated = await Promise.all(targets.map(async (t) => {
      let leadName = t.name
      let leadCompany = t.company

      if (!leadName || !leadCompany) {
        const l = leads.find(lead => lead.email === t.identifier || lead.profileUrl === t.identifier || lead.name === t.identifier || lead.url === t.identifier)
        if (l) {
          leadName = leadName || l.name
          leadCompany = leadCompany || l.company
        } else {
          const hs = hubspotContacts.find((c: any) => c.id === t.identifier || (c.properties && c.properties.email === t.identifier))
          if (hs && hs.properties) {
            leadName = leadName || `${hs.properties.firstname || ''} ${hs.properties.lastname || ''}`.trim()
            leadCompany = leadCompany || hs.properties.company
          }
        }
      }

      const safeName = leadName || 'there'
      const safeCompany = leadCompany || 'your company'

      let customText = templateText
        .replace(/\{\{Name\}\}/ig, safeName)
        .replace(/\{\{Company\}\}/ig, safeCompany)

      return { identifier: t.identifier, success: true, text: customText, leadName: safeName }
    }))

    return c.json({ results: generated })
  } catch (err: any) {
    console.error('Error in bulk generate:', err)
    return c.json({ error: 'Bulk generation failed', details: err.message }, 500)
  }
})

// ---- Send email ----

emailRoutes.post('/api/send-email', async (c) => {
  try {
    const body = await c.req.json()
    const { to, subject, text } = body

    if (!to || !subject || !text) {
      return c.json({ error: 'Missing required fields: to, subject, text' }, 400)
    }

    const result = await sendEmail(to, subject, text)
    return c.json({ success: true, messageId: result.messageId })
  } catch (error: any) {
    console.error('Error sending email:', error)
    return c.json({ error: 'Failed to send email', details: error.message }, 500)
  }
})

// ---- Bulk send emails ----

emailRoutes.post('/api/bulk-send-email', async (c) => {
  try {
    const { emails } = await c.req.json()

    if (!Array.isArray(emails)) {
      return c.json({ error: 'Missing required field: emails array' }, 400)
    }

    const results = await sendBulkEmails(emails)
    return c.json({ results })
  } catch (error: any) {
    console.error('Error in bulk send:', error)
    return c.json({ error: 'Failed to send bulk emails', details: error.message }, 500)
  }
})

export default emailRoutes
