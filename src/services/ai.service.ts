import { ai, GEMINI_MODEL } from '../config.js'
import { safeText, isCSuiteTitle, inferSector } from '../utils.js'
import type { LeadSector } from '../config.js'

// ---- AI profile signal extraction (for agent pipeline) ----

export async function aiExtractProfileSignals(
  pageTitle: string,
  metaDescription: string,
  profileUrl: string
): Promise<{ name: string; title: string; company: string; isCSuite: boolean; sector: string } | null> {
  const snippet = [pageTitle, metaDescription].filter(Boolean).join('\n').trim()
  if (!snippet) return null

  const prompt = `You are a data extraction assistant. Extract structured fields from this LinkedIn profile snippet.

Page Title: ${pageTitle}
Meta Description: ${metaDescription}
Profile URL: ${profileUrl}

Return ONLY a compact JSON object — no markdown fences, no explanation:
{"name":"","title":"","company":"","isCSuite":false,"sector":"unknown"}

sector must be one of: retail, real_estate, retail_tech, commerce, unknown
isCSuite is true only if the person holds a C-suite, President, Founder, or Managing/Executive Director title.`

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    })
    const raw = (response.text || '').trim()
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0])
    return {
      name: String(parsed.name || '').trim(),
      title: String(parsed.title || '').trim(),
      company: String(parsed.company || '').trim(),
      isCSuite: Boolean(parsed.isCSuite),
      sector: String(parsed.sector || 'unknown').trim(),
    }
  } catch {
    return null
  }
}

// ---- Email generation ----

export async function generateEmailContent(lead: {
  name?: string; title?: string; company?: string; about?: string;
  contextForAI?: string; sector?: string; confidence?: number;
  signals?: any; provenance?: any;
}, context?: string, isHubspotContact = false, isAgentLead = false): Promise<{ text: string | null; leadName: string }> {
  const leadName = lead.name || 'Unknown'

  if (isAgentLead) {
    const aiContext = `Validated candidate from public web. Confidence: ${lead.confidence}. Signals: ${JSON.stringify(lead.signals)}. Provenance: ${lead.provenance?.sourceUrl}`
    const prompt = `
You are an expert sales development representative (SDR) working for Coresight Research (coresight.com). 
Coresight Research delivers data-driven insights focusing on retail and technology, helping businesses navigate disruption reshaping global retail through proprietary intelligence and a global community of industry leaders.

Generate a highly personalized cold outreach email for the following validated lead data.

Your goal is to write a cold email that sounds natural, professional, and aims to start a conversation. 
Do NOT sound like a generic AI or use placeholders (like [Your Name]).

Lead Details:
Name: ${lead.name || 'Unknown'}
Title: ${lead.title || 'Unknown'}
Company: ${lead.company || 'Unknown'}
Sector: ${lead.sector || 'unknown'}

Additional Lead Context from AI/Scraping:
${aiContext}

User Instructions/Context:
${context || 'None'}
    `.trim()

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
    })

    return { text: response.text ?? null, leadName }
  }

  const contextInstruction = isHubspotContact
    ? `This is a contact imported from our CRM (HubSpot). We have limited context about them. Rely more on generic professional outreach best practices and the User Instructions provided below, while keeping it personalized to their name, title, and company if available.`
    : `Generate a highly personalized cold outreach email for the following lead based on their detailed profile data and context.`

  const prompt = `
You are an expert sales development representative (SDR) working for Coresight Research (coresight.com). 
Coresight Research delivers data-driven insights focusing on retail and technology, helping businesses navigate disruption reshaping global retail through proprietary intelligence and a global community of industry leaders.

${contextInstruction}

Your goal is to write a cold email that sounds natural, professional, and aims to start a conversation. 
Do NOT sound like a generic AI or use placeholders (like [Your Name]). 

Use the following real example as a benchmark for style, tone, and structure:

--- EXAMPLE EMAIL ---
Subject: Quick question, [Lead Name]

Hi [Lead Name],

Hope you're having a good week.

My name is [Your Name], and I'm an SDR at Coresight Research. We work with professionals focused on enhancing operational efficiency and improving critical workflows across various departments.

I don't have much context on your current priorities, but I was curious if finding new ways to streamline processes or gain deeper insights into business performance is an area you're exploring right now?

If not, no problem at all. If it is, I'd be happy to briefly share how others are approaching it.

Best regards,

[Your Name]
Sales Development Representative
Coresight Research
www.coresight.com
--- END EXAMPLE ---

Adapt the messaging of the example to fit the specific Lead Details and User Instructions below, but maintain the concise, low-pressure approach. Incorporate Coresight's unique value props (retail & tech data-driven insights) subtly if it makes sense for the lead's industry, otherwise stick to general business performance/efficiency.

Lead Details:
Name: ${lead.name || 'Unknown'}
Title: ${lead.title || 'Unknown'}
Company: ${lead.company || 'Unknown'}
About: ${lead.about || 'N/A'}

Additional Lead Context from AI/Scraping:
${lead.contextForAI || ''}

User Instructions/Context:
${context || 'None'}
  `.trim()

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  })

  return { text: response.text ?? null, leadName }
}

// ---- Bulk email template generation ----

export async function generateBulkTemplate(context?: string): Promise<string> {
  const prompt = `
You are an expert sales development representative (SDR) working for Coresight Research (coresight.com). 
Coresight Research delivers data-driven insights focusing on retail and technology, helping businesses navigate disruption reshaping global retail through proprietary intelligence and a global community of industry leaders.

You are writing a SINGLE bulk outreach email campaign template that will be sent to a specific group of targeted professionals.

User Instructions / Campaign Topic Context:
${context || 'General introduction to Coresight Research and an offer to share retail/tech insights.'}

Your goal is to write a natural, professional cold email template aiming to start a conversation. 

CRITICAL: You MUST use exactly these literal variables where appropriate so our system can automatically replace them:
Wait, use these EXACT strings:
- {{Name}} for the recipient's first name or full name
- {{Company}} for the recipient's company

Do NOT sound like a generic AI or use placeholders (like [Your Name]). 
Sign off naturally as an SDR from Coresight Research (e.g. "Sales Development Representative / Coresight Research").
Keep the tone concise and low-pressure.

Format:
Subject: [Your suggested subject line]

Hi {{Name}},

[Body containing {{Company}} if it makes sense]
...
  `.trim()

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  })

  return response.text || "Subject: Hello from Coresight\n\nHi {{Name}},\n\nI hope you are having a great week at {{Company}}.\n\nBest,\nSales Development Representative\nCoresight Research"
}
