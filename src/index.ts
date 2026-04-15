import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import 'dotenv/config'

// ---- Database ----
import { connectDB } from './db.js'

// ---- Routes ----
import healthRoutes from './routes/health.routes.js'
import leadsRoutes from './routes/leads.routes.js'
import hubspotRoutes, { ensureBootstrap } from './routes/hubspot.routes.js'
import agentRoutes from './routes/agent.routes.js'
import groupsRoutes from './routes/groups.routes.js'
import emailRoutes from './routes/email.routes.js'
import verificationRoutes from './routes/verification.routes.js'

// ---- App setup ----

const app = new Hono()
app.use('/*', cors())

// Mount all routes
app.route('/', healthRoutes)
app.route('/', leadsRoutes)
app.route('/', hubspotRoutes)
app.route('/', agentRoutes)
app.route('/', groupsRoutes)
app.route('/', emailRoutes)
app.route('/', verificationRoutes)

// ---- Bootstrap ----

async function boot() {
  await connectDB()
  ensureBootstrap()

  serve({
    fetch: app.fetch,
    port: 5000
  }, (info) => {
    console.log(`Server is running on http://localhost:${info.port}`)
  })
}

boot()
