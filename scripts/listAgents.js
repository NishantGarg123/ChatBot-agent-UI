import 'dotenv/config'
import { AIProjectClient } from '@azure/ai-projects'
import { DefaultAzureCredential } from '@azure/identity'

const projectEndpoint = process.env.AZURE_AI_PROJECT_ENDPOINT ?? process.env.FOUNDRY_PROJECT_ENDPOINT
const configuredAgentId = process.env.AZURE_AI_AGENT_ID ?? process.env.AZURE_AGENT_ID
const configuredAgentName = process.env.AZURE_AI_AGENT_NAME
const inputMessage = process.env.TEST_MESSAGE ?? 'Explain AI in simple terms'

if (!projectEndpoint) {
  console.error('Missing AZURE_AI_PROJECT_ENDPOINT (or FOUNDRY_PROJECT_ENDPOINT) in .env')
  process.exit(1)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const extractAssistantText = (content = []) =>
  content
    .filter((item) => item?.type === 'text' && typeof item?.text?.value === 'string')
    .map((item) => item.text.value.trim())
    .filter(Boolean)
    .join('\n')

const listAgents = async (client) => {
  if (typeof client.agents.listAgents === 'function') {
    return client.agents.listAgents()
  }
  return client.agents.list()
}

const createThread = async (client) => {
  if (typeof client.agents.createThread === 'function') {
    return client.agents.createThread()
  }
  return client.agents.threads.create()
}

const createMessage = async (client, threadId, message) => {
  if (typeof client.agents.createMessage === 'function') {
    return client.agents.createMessage(threadId, { role: 'user', content: message })
  }
  return client.agents.messages.create(threadId, 'user', message)
}

const createRun = async (client, threadId, agentId) => {
  if (typeof client.agents.createRun === 'function') {
    return client.agents.createRun(threadId, agentId)
  }
  return client.agents.runs.create(threadId, agentId)
}

const getRun = async (client, threadId, runId) => {
  if (typeof client.agents.getRun === 'function') {
    return client.agents.getRun(threadId, runId)
  }
  return client.agents.runs.get(threadId, runId)
}

const listMessages = async (client, threadId, runId) => {
  if (typeof client.agents.listMessages === 'function') {
    const page = await client.agents.listMessages(threadId, { runId, order: 'desc', limit: 20 })
    return Array.isArray(page?.data) ? page.data : []
  }

  const messages = []
  for await (const msg of client.agents.messages.list(threadId, { runId, order: 'desc', limit: 20 })) {
    messages.push(msg)
  }
  return messages
}

const resolveAgentId = async (client) => {
  const agents = await listAgents(client)
  const allAgents = []
  for await (const agent of agents) {
    allAgents.push(agent)
  }

  if (allAgents.length === 0) {
    throw new Error('No agents found in this Foundry project.')
  }

  console.log('\nAvailable agents:')
  for (const agent of allAgents) {
    console.log(`- ${agent.name} => ${agent.id}`)
  }

  if (configuredAgentId) {
    const matched = allAgents.find((agent) => agent.id === configuredAgentId)
    if (!matched) {
      throw new Error(`Configured AZURE_AI_AGENT_ID not found in project: ${configuredAgentId}`)
    }
    return matched.id
  }

  if (configuredAgentName) {
    const matched = allAgents.find((agent) => agent.name === configuredAgentName)
    if (!matched) {
      throw new Error(`Configured AZURE_AI_AGENT_NAME not found in project: ${configuredAgentName}`)
    }
    return matched.id
  }

  return allAgents[0].id
}

try {
  const client = new AIProjectClient(projectEndpoint, new DefaultAzureCredential())
  const agentId = await resolveAgentId(client)

  console.log('\nUsing agent ID:', agentId)
  const thread = await createThread(client)
  console.log('Created thread:', thread.id)

  await createMessage(client, thread.id, inputMessage)
  const run = await createRun(client, thread.id, agentId)
  console.log('Run started:', run.id)

  let finalRun = run
  for (let i = 0; i < 40; i += 1) {
    finalRun = await getRun(client, thread.id, run.id)
    if (finalRun.status === 'completed') break
    if (['failed', 'cancelled', 'cancelling', 'expired', 'requires_action'].includes(finalRun.status)) {
      throw new Error(`Run ended with status: ${finalRun.status}`)
    }
    await delay(1500)
  }

  if (finalRun.status !== 'completed') {
    throw new Error(`Run timed out with status: ${finalRun.status}`)
  }

  const messages = await listMessages(client, thread.id, finalRun.id)
  const assistant = messages.find((msg) => msg.role === 'assistant')
  const reply = extractAssistantText(assistant?.content)

  console.log('\nUser:', inputMessage)
  console.log('Assistant:', reply || '[No text reply found]')
} catch (error) {
  console.error(
    JSON.stringify(
      {
        message: 'Failed to communicate with Foundry agent.',
        cause: error?.message ?? String(error),
      },
      null,
      2,
    ),
  )
  process.exit(1)
}
