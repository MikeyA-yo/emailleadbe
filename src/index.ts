import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { GoogleGenAI } from '@google/genai'
import { readFileSync } from 'fs'
import { join } from 'path'
import 'dotenv/config';
import nodemailer from 'nodemailer';

const app = new Hono()

app.use('/*', cors())

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// Load leads
const leadsPath = join(process.cwd(), 'src', 'leads.json')
let leads: any[] = []
try {
  const data = readFileSync(leadsPath, 'utf8')
  leads = JSON.parse(data)
} catch (e) {
  console.error("Error loading leads.json:", e)
}

app.get('/', (c) => {
  return c.text('Email Lead Generation API is running!')
})

// Endpoint to get all leads
app.get('/api/leads', (c) => {
  return c.json(leads)
})

// Endpoint to generate personalized email
app.post('/api/generate-email', async (c) => {
  try {
    const body = await c.req.json()
    const { identifier, context } = body
    
    // Find the lead by email, profileUrl, or name
    const lead = leads.find(l => 
      l.email === identifier || 
      l.profileUrl === identifier || 
      l.url === identifier ||
      l.name === identifier
    )

    if (!lead) {
      return c.json({ error: 'Lead not found. Please provide a valid email, profileUrl, url, or name as identifier.' }, 404)
    }

    const aiContext = lead.contextForAI || ''
    
    const prompt = `
You are an expert sales development representative. 
Generate a highly personalized cold outreach email for the following lead based on their profile data and context.
The email should be professional, engaging, and aim to start a conversation.
Keep it concise and do not include placeholders like [Your Name] unless specifically instructed.

Lead Details:
Name: ${lead.name || 'Unknown'}
Title: ${lead.title || 'Unknown'}
Company: ${lead.company || 'Unknown'}
About: ${lead.about || 'N/A'}

Additional Lead Context from AI/Scraping:
${aiContext}

User Instructions/Context:
${context || 'None'}
    `.trim()

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    })

    const emailContent = response.text

    // Return plain text as well for proper displays
    return c.json({ 
      success: true,
      text: emailContent,
      leadName: lead.name
    })

  } catch (error) {
    console.error("Error generating email:", error)
    return c.json({ error: 'Failed to generate email' }, 500)
  }
})

// Nodemailer transporter (Office 365)
const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || 'elijah@coresight.com',
    pass: process.env.SMTP_PASS || '',
  },
  tls: {
    ciphers: 'SSLv3',
    rejectUnauthorized: false,
  },
});

// Endpoint to send an email
app.post('/api/send-email', async (c) => {
  try {
    const body = await c.req.json();
    const { to, subject, text } = body;

    if (!to || !subject || !text) {
      return c.json({ error: 'Missing required fields: to, subject, text' }, 400);
    }

    const info = await transporter.sendMail({
      from: process.env.SMTP_USER || 'elijah@coresight.com',
      to,
      subject,
      text,
    });

    return c.json({
      success: true,
      messageId: info.messageId,
    });
  } catch (error: any) {
    console.error('Error sending email:', error);
    return c.json({ error: 'Failed to send email', details: error.message }, 500);
  }
});

serve({
  fetch: app.fetch,
  port: 5000
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
