import { Hono } from 'hono'
import { VerificationResult } from '../db.js'
import {
  verifyBatch,
  getVerificationStats,
  getVerificationResults,
} from '../services/verification.service.js'
import {
  updateHubSpotContact,
  ensureVerificationProperties,
} from '../services/hubspot.service.js'
import { apiError } from '../utils.js'

const verificationRoutes = new Hono()

// ---- POST /api/verification/run ----
// Trigger verification for a batch of HubSpot contacts

verificationRoutes.post('/api/verification/run', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    if (!process.env.GEMINI_API_KEY) {
      return c.json(apiError('CONFIG_ERROR', 'GEMINI_API_KEY is not set'), 500)
    }
    if (!process.env.HUBSPOT_TOKEN) {
      return c.json(apiError('CONFIG_ERROR', 'HUBSPOT_TOKEN is not set'), 500)
    }

    const filters = body.filters || {}
    const limit = Math.min(Number(body.limit || 10), 25)
    const after = body.after ? String(body.after) : undefined

    const result = await verifyBatch({
      filters: {
        industry: filters.industry,
        company: filters.company,
        role: filters.role,
        region: filters.region,
        lastUpdatedDays: filters.lastUpdatedDays ? Number(filters.lastUpdatedDays) : undefined,
        leadStatus: filters.leadStatus,
      },
      limit,
      after,
    })

    return c.json(result)
  } catch (error: any) {
    console.error('[verification/run] Error:', error)
    return c.json(apiError('INTERNAL_ERROR', 'Verification run failed', error?.message), 500)
  }
})

// ---- GET /api/verification/results ----
// Get paginated, filterable verification results

verificationRoutes.get('/api/verification/results', async (c) => {
  try {
    const status = c.req.query('status') || 'all'
    const batchId = c.req.query('batchId')
    const limit = parseInt(c.req.query('limit') || '50', 10)
    const offset = parseInt(c.req.query('offset') || '0', 10)
    const search = c.req.query('search')
    const discarded = c.req.query('discarded') === 'true'

    const data = await getVerificationResults({
      status,
      batchId,
      limit,
      offset,
      search,
      discarded,
    })

    return c.json(data)
  } catch (error: any) {
    console.error('[verification/results] Error:', error)
    return c.json(apiError('INTERNAL_ERROR', 'Failed to fetch verification results', error?.message), 500)
  }
})

// ---- GET /api/verification/results/:id ----
// Get a single verification result

verificationRoutes.get('/api/verification/results/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const result = await VerificationResult.findById(id).lean()

    if (!result) {
      return c.json(apiError('NOT_FOUND', 'Verification result not found'), 404)
    }

    return c.json(result)
  } catch (error: any) {
    console.error('[verification/results/:id] Error:', error)
    return c.json(apiError('INTERNAL_ERROR', 'Failed to fetch verification result', error?.message), 500)
  }
})

// ---- GET /api/verification/stats ----
// Dashboard summary stats

verificationRoutes.get('/api/verification/stats', async (c) => {
  try {
    const stats = await getVerificationStats()
    return c.json(stats)
  } catch (error: any) {
    console.error('[verification/stats] Error:', error)
    return c.json(apiError('INTERNAL_ERROR', 'Failed to fetch verification stats', error?.message), 500)
  }
})

// ---- POST /api/verification/sync/:id ----
// Push verified LinkedIn data back to HubSpot for a single result

verificationRoutes.post('/api/verification/sync/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const result = await VerificationResult.findById(id) as any

    if (!result) {
      return c.json(apiError('NOT_FOUND', 'Verification result not found'), 404)
    }

    if (result.status === 'match') {
      return c.json({
        success: true,
        message: 'No update needed — HubSpot data already matches LinkedIn.',
        hubspotContactId: result.hubspotContactId,
      })
    }

    if (!result.hubspotContactId) {
      return c.json(apiError('INVALID_STATE', 'No HubSpot contact ID on this verification result'), 400)
    }

    // Ensure custom properties exist before writing
    await ensureVerificationProperties()

    // Build update payload
    const properties: Record<string, string> = {}

    if (result.status === 'stale' && result.changes?.newCompany) {
      properties.company = result.changes.newCompany
    }
    if ((result.status === 'stale' || result.status === 'discrepancy') && result.changes?.newTitle) {
      properties.jobtitle = result.changes.newTitle
    }

    // Always write verification metadata
    properties.lead_verification_status = result.status
    properties.lead_last_verified_at = new Date().toISOString()

    const updateResult = await updateHubSpotContact(result.hubspotContactId, properties)

    if (updateResult.success) {
      result.hubspotSyncedAt = new Date()
      await result.save()

      return c.json({
        success: true,
        message: `HubSpot contact ${result.hubspotContactId} updated successfully.`,
        updatedProperties: properties,
        hubspotContactId: result.hubspotContactId,
      })
    } else {
      return c.json(apiError('HUBSPOT_ERROR', 'Failed to update HubSpot', updateResult.error), 502)
    }
  } catch (error: any) {
    console.error('[verification/sync/:id] Error:', error)
    return c.json(apiError('INTERNAL_ERROR', 'Failed to sync verification to HubSpot', error?.message), 500)
  }
})

// ---- POST /api/verification/sync-bulk ----
// Bulk push verified data back to HubSpot

verificationRoutes.post('/api/verification/sync-bulk', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))
    const { verificationIds, batchId } = body

    let results: any[] = []

    if (Array.isArray(verificationIds) && verificationIds.length > 0) {
      results = await VerificationResult.find({ _id: { $in: verificationIds } }) as any[]
    } else if (batchId) {
      results = await VerificationResult.find({
        batchId,
        status: { $in: ['stale', 'discrepancy'] },
        discarded: { $ne: true },
        hubspotSyncedAt: null,
      }) as any[]
    } else {
      return c.json(apiError('INVALID_INPUT', 'Must provide verificationIds array or batchId'), 400)
    }

    if (!results.length) {
      return c.json({ success: true, synced: 0, failed: 0, results: [] })
    }

    // Ensure custom properties exist
    await ensureVerificationProperties()

    const syncResults: any[] = []

    for (const result of results) {
      if (!result.hubspotContactId) {
        syncResults.push({ id: result._id, success: false, reason: 'no_hubspot_id' })
        continue
      }

      if (result.status === 'match') {
        // Just update verification status, no data change
        const updateRes = await updateHubSpotContact(result.hubspotContactId, {
          lead_verification_status: 'match',
          lead_last_verified_at: new Date().toISOString(),
        })

        if (updateRes.success) {
          result.hubspotSyncedAt = new Date()
          await result.save()
        }

        syncResults.push({ id: result._id, hubspotContactId: result.hubspotContactId, success: updateRes.success, status: 'match' })
        continue
      }

      const properties: Record<string, string> = {}
      if (result.status === 'stale' && result.changes?.newCompany) {
        properties.company = result.changes.newCompany
      }
      if ((result.status === 'stale' || result.status === 'discrepancy') && result.changes?.newTitle) {
        properties.jobtitle = result.changes.newTitle
      }
      properties.lead_verification_status = result.status
      properties.lead_last_verified_at = new Date().toISOString()

      const updateRes = await updateHubSpotContact(result.hubspotContactId, properties)

      if (updateRes.success) {
        result.hubspotSyncedAt = new Date()
        await result.save()
      }

      syncResults.push({
        id: result._id,
        hubspotContactId: result.hubspotContactId,
        success: updateRes.success,
        status: result.status,
        updatedProperties: updateRes.success ? properties : undefined,
        error: updateRes.error,
      })
    }

    return c.json({
      success: true,
      synced: syncResults.filter(r => r.success).length,
      failed: syncResults.filter(r => !r.success).length,
      results: syncResults,
    })
  } catch (error: any) {
    console.error('[verification/sync-bulk] Error:', error)
    return c.json(apiError('INTERNAL_ERROR', 'Bulk sync failed', error?.message), 500)
  }
})

// ---- POST /api/verification/discard/:id ----
// Mark a verification result as discarded (soft delete)

verificationRoutes.post('/api/verification/discard/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const result = await VerificationResult.findByIdAndUpdate(
      id,
      { discarded: true, discardedAt: new Date() },
      { new: true }
    )

    if (!result) {
      return c.json(apiError('NOT_FOUND', 'Verification result not found'), 404)
    }

    return c.json({ success: true, id: result._id, discarded: true })
  } catch (error: any) {
    console.error('[verification/discard/:id] Error:', error)
    return c.json(apiError('INTERNAL_ERROR', 'Failed to discard verification result', error?.message), 500)
  }
})

export default verificationRoutes
