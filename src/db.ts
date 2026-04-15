import mongoose from 'mongoose'
import { TARGET_SECTORS } from './config.js'

// ---- MongoDB Connection ----

export async function connectDB() {
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI)
      console.log('Connected to MongoDB successfully')
    } catch (err) {
      console.error('MongoDB connection error:', err)
    }
  } else {
    console.warn('MONGODB_URI is not set. Grouping and verification features will not work until a database is configured.')
  }
}

// ---- Group Schema ----

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  contacts: [{
    identifier: { type: String, required: true },
    leadSource: { type: String, required: true },
    name: { type: String },
    company: { type: String },
  }]
})

export const Group = mongoose.models.Group || mongoose.model('Group', groupSchema)

// ---- AgentLead Schema ----

const agentLeadSchema = new mongoose.Schema({
  identifier: { type: String, required: true, unique: true, index: true },
  profileUrl: { type: String, default: '' },
  name: { type: String, default: '' },
  title: { type: String, default: '' },
  company: { type: String, default: '' },
  sector: { type: String, enum: [...TARGET_SECTORS, 'unknown'], default: 'unknown' },
  isCSuite: { type: Boolean, required: true },
  confidence: { type: Number, min: 0, max: 1, required: true },
  provenance: {
    sourceUrl: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
    method: { type: String, required: true }
  },
  signals: {
    titleMatch: { type: Boolean, required: true },
    sectorMatch: { type: Boolean, required: true },
    companyMatch: { type: Boolean, required: true }
  },
  raw: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true })

export const AgentLead = mongoose.models.AgentLead || mongoose.model('AgentLead', agentLeadSchema)

// ---- CrawlAttempt Schema ----

const crawlAttemptSchema = new mongoose.Schema({
  url: { type: String, required: true },
  normalizedUrl: { type: String, required: true, index: true },
  query: { type: String, default: '' },
  status: { type: String, enum: ['success', 'failed', 'blocked', 'skipped'], required: true },
  reason: { type: String, default: '' },
  responseStatus: { type: Number },
  attemptedAt: { type: Date, default: Date.now, index: true }
}, { timestamps: false })

export const CrawlAttempt = mongoose.models.CrawlAttempt || mongoose.model('CrawlAttempt', crawlAttemptSchema)

// ---- VerificationResult Schema ----

export const VERIFICATION_STATUSES = ['match', 'stale', 'discrepancy', 'unverified', 'error', 'not_found'] as const
export type VerificationStatus = typeof VERIFICATION_STATUSES[number]

const verificationResultSchema = new mongoose.Schema({
  // HubSpot source data (snapshot at time of verification)
  hubspotContactId: { type: String, required: true, index: true },
  hubspotData: {
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    fullName: { type: String, default: '' },
    company: { type: String, default: '' },
    jobTitle: { type: String, default: '' },
    email: { type: String, default: '' },
    linkedinUrl: { type: String, default: '' },
    industry: { type: String, default: '' },
    leadStatus: { type: String, default: '' },
  },

  // LinkedIn discovered data
  linkedinData: {
    profileUrl: { type: String, default: '' },
    name: { type: String, default: '' },
    currentCompany: { type: String, default: '' },
    currentTitle: { type: String, default: '' },
    headline: { type: String, default: '' },
    location: { type: String, default: '' },
  },

  // Verification verdict
  status: {
    type: String,
    enum: VERIFICATION_STATUSES,
    default: 'unverified',
    index: true,
  },

  // Change tracking (populated for stale/discrepancy)
  changes: {
    previousCompany: { type: String, default: '' },
    previousTitle: { type: String, default: '' },
    newCompany: { type: String, default: '' },
    newTitle: { type: String, default: '' },
    companyChanged: { type: Boolean, default: false },
    titleChanged: { type: Boolean, default: false },
  },

  // AI-generated fields
  aiSummary: { type: String, default: '' },
  aiConfidence: { type: Number, min: 0, max: 1, default: 0 },

  // Metadata
  batchId: { type: String, index: true },
  verifiedAt: { type: Date, default: Date.now, index: true },
  hubspotSyncedAt: { type: Date, default: null },
  discarded: { type: Boolean, default: false },
  discardedAt: { type: Date, default: null },
}, { timestamps: true })

// Compound indexes for efficient dashboard queries
verificationResultSchema.index({ status: 1, verifiedAt: -1 })
verificationResultSchema.index({ hubspotContactId: 1, verifiedAt: -1 })
verificationResultSchema.index({ batchId: 1, status: 1 })

export const VerificationResult = mongoose.models.VerificationResult || mongoose.model('VerificationResult', verificationResultSchema)
