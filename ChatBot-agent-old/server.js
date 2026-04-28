/* global process */
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import mysql from 'mysql2/promise'
import { AIProjectClient } from '@azure/ai-projects'
import { DefaultAzureCredential } from '@azure/identity'

const PORT = Number.parseInt(process.env.PORT ?? '4000', 10)
const MYSQL_HOST = process.env.DB_HOST ?? 'localhost'
const MYSQL_PORT = Number.parseInt(process.env.DB_PORT ?? '3310', 10)
const MYSQL_USER = process.env.DB_USER ?? 'root'
const MYSQL_PASSWORD = process.env.DB_PASSWORD ?? 'root'
const MYSQL_DATABASE = process.env.DB_NAME ?? 'dexi_bots'

// const responsesUrl = process.env.AZURE_RESPONSES_URL ?? process.env.VITE_RAG_API_URL
// const azureApiKey = process.env.AZURE_API_KEY ?? process.env.VITE_AZURE_API_KEY
const projectEndpoint = process.env.AZURE_AI_PROJECT_ENDPOINT ?? process.env.FOUNDRY_PROJECT_ENDPOINT
const configuredAgentName = process.env.AZURE_AGENT_NAME
const configuredAgentId = process.env.AZURE_AI_AGENT_ID ?? process.env.AZURE_AGENT_ID
const pollIntervalMs = Number.parseInt(process.env.AZURE_AGENT_POLL_INTERVAL_MS ?? '1200', 10)
const maxPollAttempts = Number.parseInt(process.env.AZURE_AGENT_MAX_POLL_ATTEMPTS ?? '40', 10)

if (!projectEndpoint) {
  throw new Error('Missing AZURE_AI_PROJECT_ENDPOINT (or FOUNDRY_PROJECT_ENDPOINT) in .env')
}

// if (!responsesUrl || !azureApiKey) {
//   throw new Error('Missing AZURE_RESPONSES_URL (or VITE_RAG_API_URL) and AZURE_API_KEY (or VITE_AZURE_API_KEY) in .env')
// }

const app = express()
app.use(cors())
app.use(express.json())

let pool
const projectClient = new AIProjectClient(projectEndpoint, new DefaultAzureCredential())
const openai = projectClient.getOpenAIClient()
let agentReferencePromise

const listAgents = async (client) => {
  if (typeof client.agents.listAgents === 'function') {
    return client.agents.listAgents()
  }
  return client.agents.list()
}

const resolveAgentReference = async () => {
  if (!agentReferencePromise) {
    agentReferencePromise = (async () => {
      const agents = await listAgents(projectClient)
      const allAgents = []
      for await (const agent of agents) {
        allAgents.push(agent)
      }
      if (allAgents.length === 0) {
        throw new Error('No agents found in this Foundry project.')
      }

      let selectedAgent = allAgents[0]
      if (configuredAgentId) {
        const byId = allAgents.find((agent) => agent.id === configuredAgentId)
        if (!byId) {
          throw new Error(`Configured AZURE_AI_AGENT_ID not found in project: ${configuredAgentId}`)
        }
        selectedAgent = byId
      } else if (configuredAgentName) {
        const byName = allAgents.find((agent) => agent.name === configuredAgentName)
        if (!byName) {
          throw new Error(`Configured AZURE_AGENT_NAME not found in project: ${configuredAgentName}`)
        }
        selectedAgent = byName
      }

      return {
        id: selectedAgent.id,
        name: selectedAgent.name,
        type: 'agent_reference',
      }
    })()
  }

  return agentReferencePromise
}

// const getAuthHeaders = () => ({
//   'Content-Type': 'application/json',
//   'api-key': azureApiKey,
// })

const getAssistantText = (output = []) =>
  output
    .filter((item) => item?.type === 'message' && item?.role === 'assistant')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((item) => item?.type === 'output_text' && typeof item?.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n')

const getUsage = (data) => {
  const usage = data?.usage
  if (!usage) return null
  const inputTokens = Number(usage.input_tokens)
  const outputTokens = Number(usage.output_tokens)
  const totalTokens = Number(usage.total_tokens)
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || !Number.isFinite(totalTokens)) {
    return null
  }
  return { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens }
}

const getDocumentScore = (doc) => {
  const value = doc?.score ?? doc?.['@search.score'] ?? doc?.searchScore ?? doc?.rerankerScore
  const score = Number(value)
  return Number.isFinite(score) ? score : 0
}

const getPageFromId = (id) => {
  if (typeof id !== 'string') return null
  const match = id.match(/_pages_(\d+)/i)
  if (!match?.[1]) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : null
}

const getChunkIndexFromId = (id) => getPageFromId(id)

const getPdfFileName = (doc = {}) => {
  const idValue = typeof doc.id === 'string' ? doc.id : ''
  const idMatch = idValue.match(/equipment-files\/(.+?)(?:_pages_|$)/i)
  const fromId = idMatch?.[1] ?? null

  const candidate = fromId
    ?? doc.fileName
    ?? doc.filename
    ?? doc.file_name
    ?? doc.pdfFileName
    ?? doc.documentName
    ?? doc.metadata_storage_name
    ?? doc.sourcefile
    ?? doc.source
    ?? doc.title

  if (!candidate || typeof candidate !== 'string') return null
  const raw = candidate.split('?')[0].split('#')[0].split('/').pop()?.trim()
  if (!raw) return null

  let clean = raw
  try {
    clean = decodeURIComponent(clean)
  } catch {
    clean = raw
  }

  clean = clean.replace(/(\.pdf)\d+$/i, '$1')
  if (!/\.pdf$/i.test(clean)) clean = `${clean}.pdf`
  return clean
}

const extractSources = (output = []) => {
  const searchOutput = output.find((item) => item?.type === 'azure_ai_search_call_output')
  if (!searchOutput?.output) return []

  let parsed = null
  try {
    parsed = typeof searchOutput.output === 'string' ? JSON.parse(searchOutput.output) : searchOutput.output
  } catch {
    return []
  }

  if (!Array.isArray(parsed?.documents)) return []
  return parsed.documents
    .filter((doc) => getDocumentScore(doc) > 0.025)
    .map((doc, index) => ({
      num: index + 1,
      title: doc.title ?? 'Document',
      content: doc.content ?? '',
      id: doc.id ?? null,
      page: getPageFromId(doc.id),
      chunkIndex: getChunkIndexFromId(doc.id),
      score: getDocumentScore(doc),
      fileName: getPdfFileName(doc),
    }))
}

const ensureDatabase = async () => {
  const adminPool = mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    waitForConnections: true,
    connectionLimit: 10,
  })

  await adminPool.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\``)
  await adminPool.end()

  pool = mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
  })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_id (
      id INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id VARCHAR(255) NOT NULL UNIQUE,
      initial_message TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

const createConversation = async () => {
  const conversation = await openai.conversations.create()
  if (!conversation?.id) throw new Error('Conversation create response missing id.')
  return conversation.id
}

const createResponse = async ({ conversationId, message }) => {
  const agentRef = await resolveAgentReference()
  return openai.responses.create({
    conversation: conversationId,
    input: message,
    agent_reference: {
      type: 'agent_reference',
      name: agentRef.name,
    },
  })
}

const retrieveResponse = async (responseId) => {
  return openai.responses.retrieve(responseId)
}

const waitForCompletion = async (responseData) => {
  let current = responseData
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    if (current.status === 'completed') return current
    if (['failed', 'cancelled', 'expired', 'incomplete'].includes(current.status)) {
      throw new Error(`Foundry response ended with status: ${current.status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    current = await retrieveResponse(current.id)
  }
  throw new Error(`Foundry response timed out with status: ${current.status}`)
}

const listConversationItems = async (conversationId) => {
  return openai.conversations.items.list(conversationId, { queryParameters: { limit: 100 } })
}

const mapConversationItemsToMessages = (items = []) =>
  items
    .filter((item) => item?.type === 'message')
    .map((item, idx) => {
      const text = (item.content ?? [])
        .map((contentItem) => {
          if (contentItem?.type === 'input_text' && typeof contentItem?.text === 'string') return contentItem.text
          if (contentItem?.type === 'output_text' && typeof contentItem?.text === 'string') return contentItem.text
          if (typeof contentItem?.text === 'string') return contentItem.text
          return null
        })
        .filter(Boolean)
        .join('\n')
        .trim()

      return {
        id: item.id ?? `msg_${idx}`,
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: text,
        time: item.created_at ? new Date(item.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      }
    })
    .filter((message) => message.content.length > 0)
    .reverse()

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true })
})

app.get('/api/conversations', async (_req, res) => {
  const [rows] = await pool.query(
    'SELECT conversation_id, initial_message, created_at FROM conversation_id ORDER BY created_at DESC',
  )
  res.status(200).json(rows)
})

app.get('/api/conversations/:conversationId/messages', async (req, res) => {
  const { conversationId } = req.params
  const response = await listConversationItems(conversationId)
  const messages = mapConversationItemsToMessages(Array.isArray(response?.data) ? response.data : [])
  res.status(200).json({ conversationId, messages })
})

app.post('/api/chat', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  let conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : ''

  if (!message) {
    return res.status(400).json({ error: 'A non-empty `message` field is required.' })
  }

  if (!conversationId) {
    conversationId = await createConversation()
    await pool.query(
      'INSERT INTO conversation_id (conversation_id, initial_message) VALUES (?, ?) ON DUPLICATE KEY UPDATE initial_message = VALUES(initial_message)',
      [conversationId, message],
    )
  }

  const responseData = await createResponse({ conversationId, message })
  const finalResponse = await waitForCompletion(responseData)

  return res.status(200).json({
    conversationId,
    assistantMessage: getAssistantText(finalResponse.output),
    usage: getUsage(finalResponse),
    sources: extractSources(finalResponse.output),
    output: finalResponse.output,
  })
})

app.use((error, _req, res, next) => {
  void next
  console.error(error)
  res.status(500).json({
    error: error?.message ?? 'Unexpected server error.',
  })
})

ensureDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`)
    })
  })
  .catch((error) => {
    console.error('Failed to initialize backend:', error.message)
    process.exit(1)
  })

// All arrow functions name - 
 // listConversationItems    --> list the all conversations items using the stored conversation_id
  // mapConversationItemsToMessages   --> list the all msg from the given conversation item.
  // listAgents                -->  list the agents from the given project endpoint.
  // resolveAgentReference     --> this find the agent by stored agent_id first if not found then try using the agent name.
  // createResponse       --> create the response using the agent_id in the conversation_id
  // waitForCompletion    --> Function check that agent response is completed or have an error.
  // getAssistantText
  // getUsage
  // getDocumentScore
  // getPageFromId
  // getChunkIndexFromId
  // getPdfFileName
  // extractSources
  // ensureDatabase
  // createConversation
  // retrieveResponse
  
 