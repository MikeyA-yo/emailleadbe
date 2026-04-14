import { safeText } from '../utils.js'

// ---- In-memory HubSpot contacts cache ----
// (Preserved from original monolith behavior — bootstrap from hubspot.json, then fetch more as needed)

let hubspotContacts: any[] = []
let hubspotCursor: string | undefined = undefined
let isFetchingHubspot = false

export function getHubspotContacts() { return hubspotContacts }
export function setHubspotContacts(contacts: any[]) { hubspotContacts = contacts }

// ---- Ensure enough HubSpot contacts are loaded in memory ----

export async function ensureHubspotContacts(requiredCount: number) {
  if (hubspotContacts.length >= requiredCount) return
  if (isFetchingHubspot) {
    while (isFetchingHubspot && hubspotContacts.length < requiredCount) {
      await new Promise(r => setTimeout(r, 500))
    }
    if (hubspotContacts.length >= requiredCount) return
  }

  isFetchingHubspot = true
  try {
    const ht = process.env.HUBSPOT_TOKEN
    if (!ht) {
      console.warn("HUBSPOT_TOKEN is not set. Cannot fetch more contacts.")
      return
    }

    const existingIds = new Set(hubspotContacts.map(c => c.id))
    let i = 0

    while (hubspotContacts.length < requiredCount) {
      const url = new URL("https://api.hubapi.com/crm/v3/objects/contacts")
      url.searchParams.set("limit", "100")
      url.searchParams.append("properties", "firstname")
      url.searchParams.append("properties", "lastname")
      url.searchParams.append("properties", "email")
      url.searchParams.append("properties", "company")
      url.searchParams.append("properties", "jobtitle")
      url.searchParams.append("properties", "hs_email_last_open_date")
      url.searchParams.append("properties", "hs_email_last_click_date")
      url.searchParams.append("properties", "industry")
      url.searchParams.append("properties", "notes_last_activity_date")

      if (hubspotCursor) {
        url.searchParams.set("after", hubspotCursor)
      }

      console.log(`Fetching more HubSpot contacts (required: ${requiredCount}, current: ${hubspotContacts.length})...`)
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${ht}`,
          "Content-Type": "application/json",
        },
      })

      if (!res.ok) {
        console.error(`HubSpot API error: ${res.status} ${res.statusText}`)
        break
      }

      const data = await res.json()
      if (!data.results || data.results.length === 0) break

      let added = 0
      for (const contact of data.results) {
        if (!existingIds.has(contact.id)) {
          hubspotContacts.push(contact)
          existingIds.add(contact.id)
          added++
        }
      }

      console.log(`Fetched ${data.results.length} contacts, added ${added} novel ones. Total: ${hubspotContacts.length}`)

      if (data.paging?.next?.after) {
        hubspotCursor = data.paging.next.after
        if (i > 500) break
        i++
      } else {
        break
      }
    }
  } catch (err) {
    console.error("Error ensuring HubSpot contacts:", err)
  } finally {
    isFetchingHubspot = false
  }
}

// ---- Fetch contacts directly from HubSpot API (no cache) ----

const HUBSPOT_CONTACT_PROPERTIES = [
  'firstname', 'lastname', 'email', 'company', 'jobtitle',
  'industry', 'notes_last_activity_date', 'hs_lead_status',
  'hs_email_last_open_date', 'hs_email_last_click_date',
  'state', 'city', 'country',
]

export async function fetchHubspotContactsDirect(options: {
  limit?: number
  after?: string
  filters?: {
    industry?: string
    company?: string
    role?: string
    region?: string
    interacted?: boolean
    lastUpdatedDays?: number
    leadStatus?: string
  }
}): Promise<{ contacts: any[], nextCursor: string | null }> {
  const ht = process.env.HUBSPOT_TOKEN
  if (!ht) throw new Error('HUBSPOT_TOKEN is not set')

  const limit = options.limit || 25
  const filters = options.filters || {}

  // If filters are provided, use the Search API
  if (Object.keys(filters).some(k => filters[k as keyof typeof filters] !== undefined)) {
    return fetchHubspotContactsWithFilters(ht, limit, options.after, filters)
  }

  // Otherwise use the simple list API
  const url = new URL('https://api.hubapi.com/crm/v3/objects/contacts')
  url.searchParams.set('limit', String(limit))
  for (const prop of HUBSPOT_CONTACT_PROPERTIES) {
    url.searchParams.append('properties', prop)
  }
  if (options.after) url.searchParams.set('after', options.after)

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${ht}`, 'Content-Type': 'application/json' }
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`HubSpot API returned ${res.status}: ${errText}`)
  }

  const data = await res.json()
  return {
    contacts: data.results || [],
    nextCursor: data.paging?.next?.after || null
  }
}

async function fetchHubspotContactsWithFilters(
  token: string,
  limit: number,
  after: string | undefined,
  filters: NonNullable<Parameters<typeof fetchHubspotContactsDirect>[0]['filters']>
): Promise<{ contacts: any[], nextCursor: string | null }> {
  const filterClauses: any[] = []

  if (filters.company) {
    filterClauses.push({ propertyName: 'company', operator: 'CONTAINS_TOKEN', value: filters.company })
  }
  if (filters.role) {
    filterClauses.push({ propertyName: 'jobtitle', operator: 'CONTAINS_TOKEN', value: filters.role })
  }
  if (filters.industry) {
    filterClauses.push({ propertyName: 'industry', operator: 'CONTAINS_TOKEN', value: filters.industry })
  }
  if (filters.leadStatus) {
    filterClauses.push({ propertyName: 'hs_lead_status', operator: 'EQ', value: filters.leadStatus })
  }
  if (filters.interacted === true) {
    filterClauses.push({ propertyName: 'hs_email_last_open_date', operator: 'HAS_PROPERTY' })
  } else if (filters.interacted === false) {
    filterClauses.push({ propertyName: 'hs_email_last_open_date', operator: 'NOT_HAS_PROPERTY' })
  }
  if (filters.lastUpdatedDays && filters.lastUpdatedDays > 0) {
    const cutoff = new Date(Date.now() - filters.lastUpdatedDays * 24 * 60 * 60 * 1000).toISOString()
    filterClauses.push({ propertyName: 'notes_last_activity_date', operator: 'LT', value: cutoff })
  }

  let filterGroups: any[] = []

  if (filters.region) {
    filterGroups = [
      { filters: [...filterClauses, { propertyName: 'state', operator: 'CONTAINS_TOKEN', value: filters.region }] },
      { filters: [...filterClauses, { propertyName: 'city', operator: 'CONTAINS_TOKEN', value: filters.region }] },
      { filters: [...filterClauses, { propertyName: 'country', operator: 'CONTAINS_TOKEN', value: filters.region }] },
    ]
  } else if (filterClauses.length > 0) {
    filterGroups = [{ filters: filterClauses }]
  }

  const searchBody: any = {
    limit,
    properties: HUBSPOT_CONTACT_PROPERTIES,
  }
  if (filterGroups.length > 0) searchBody.filterGroups = filterGroups
  if (after) searchBody.after = after

  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(searchBody),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`HubSpot Search API returned ${res.status}: ${errText}`)
  }

  const data = await res.json()
  return {
    contacts: data.results || [],
    nextCursor: data.paging?.next?.after || null
  }
}

// ---- HubSpot Write-Back ----

export async function updateHubSpotContact(
  contactId: string,
  properties: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const ht = process.env.HUBSPOT_TOKEN
  if (!ht) return { success: false, error: 'HUBSPOT_TOKEN is not set' }

  try {
    const res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ht}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error(`HubSpot PATCH error for ${contactId}:`, res.status, errText)
      return { success: false, error: `HubSpot returned ${res.status}: ${errText}` }
    }

    return { success: true }
  } catch (err: any) {
    console.error(`HubSpot PATCH exception for ${contactId}:`, err.message)
    return { success: false, error: err.message }
  }
}

// ---- Ensure custom HubSpot properties exist ----

let customPropertiesChecked = false

export async function ensureVerificationProperties(): Promise<void> {
  if (customPropertiesChecked) return
  const ht = process.env.HUBSPOT_TOKEN
  if (!ht) return

  const propertiesToEnsure = [
    {
      name: 'lead_verification_status',
      label: 'Lead Verification Status',
      type: 'enumeration',
      fieldType: 'select',
      groupName: 'contactinformation',
      options: [
        { label: 'Match', value: 'match', displayOrder: 0 },
        { label: 'Stale', value: 'stale', displayOrder: 1 },
        { label: 'Discrepancy', value: 'discrepancy', displayOrder: 2 },
        { label: 'Unverified', value: 'unverified', displayOrder: 3 },
        { label: 'Not Found', value: 'not_found', displayOrder: 4 },
      ]
    },
    {
      name: 'lead_last_verified_at',
      label: 'Lead Last Verified At',
      type: 'datetime',
      fieldType: 'date',
      groupName: 'contactinformation',
    }
  ]

  for (const prop of propertiesToEnsure) {
    try {
      // Check if property exists
      const checkRes = await fetch(`https://api.hubapi.com/crm/v3/properties/contacts/${prop.name}`, {
        headers: { Authorization: `Bearer ${ht}` }
      })

      if (checkRes.status === 404) {
        // Create the property
        console.log(`Creating HubSpot custom property: ${prop.name}`)
        const createRes = await fetch('https://api.hubapi.com/crm/v3/properties/contacts', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ht}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(prop),
        })

        if (createRes.ok) {
          console.log(`Created HubSpot property: ${prop.name}`)
        } else {
          const errText = await createRes.text()
          console.warn(`Failed to create HubSpot property ${prop.name}: ${createRes.status} ${errText}`)
        }
      } else if (checkRes.ok) {
        console.log(`HubSpot property ${prop.name} already exists`)
      }
    } catch (err: any) {
      console.warn(`Error checking/creating HubSpot property ${prop.name}:`, err.message)
    }
  }

  customPropertiesChecked = true
}

// ---- Fetch a single contact by ID ----

export async function fetchHubspotContactById(contactId: string): Promise<any | null> {
  const ht = process.env.HUBSPOT_TOKEN
  if (!ht) return null

  try {
    const url = new URL(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`)
    for (const prop of HUBSPOT_CONTACT_PROPERTIES) {
      url.searchParams.append('properties', prop)
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${ht}` }
    })

    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
