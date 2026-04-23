import { AIProjectClient } from '@azure/ai-projects'
import { DefaultAzureCredential } from '@azure/identity'

const POLL_INTERVAL_MS = Number.parseInt(process.env.AZURE_AGENT_POLL_INTERVAL_MS ?? '1500', 10)
const MAX_POLL_ATTEMPTS = Number.parseInt(process.env.AZURE_AGENT_MAX_POLL_ATTEMPTS ?? '40', 10)

class AzureAgentServiceError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message)
    this.name = 'AzureAgentServiceError'
    this.statusCode = statusCode
    this.details = details
  }
}

let cachedClient

const getErrorMessage = (error) => error?.message ?? String(error)

const isAzureAuthenticationError = (error) => {
  const message = getErrorMessage(error)
  return (
    error?.name === 'AuthenticationError' ||
    message.includes('ChainedTokenCredential authentication failed') ||
    message.includes('EnvironmentCredential authentication failed') ||
    message.includes('CredentialUnavailableError') ||
    message.includes('ManagedIdentityCredential') ||
    message.includes('Visual Studio Code Authentication is not available')
  )
}

const toAzureServiceError = (error, fallbackMessage, extraDetails = {}) => {
  if (error instanceof AzureAgentServiceError) {
    return error
  }

  if (isAzureAuthenticationError(error)) {
    return new AzureAgentServiceError(
      'Azure authentication failed. Verify AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, and the app registration access to the Foundry project.',
      502,
      {
        cause: getErrorMessage(error),
        ...extraDetails,
      },
    )
  }

  return new AzureAgentServiceError(
    fallbackMessage,
    502,
    {
      cause: getErrorMessage(error),
      ...extraDetails,
    },
  )
}

const getRequiredEnv = (name, fallbackNames = []) => {
  const candidateNames = [name, ...fallbackNames]

  for (const candidate of candidateNames) {
    const value = process.env[candidate]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }

  throw new AzureAgentServiceError(
    `Missing required environment variable: ${name}.`,
    500,
    { missingVariable: name },
  )
}

const getAgentId = () => {
  const agentId = getRequiredEnv('AZURE_AI_AGENT_ID', ['AZURE_AGENT_ID'])

  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
    throw new AzureAgentServiceError(
      'Invalid AZURE_AI_AGENT_ID. Use the actual Azure Foundry agent/assistant ID, not a name:version value like `agent-equipment:20`.',
      500,
      { agentId },
    )
  }

  return agentId
}

const getProjectEndpoint = () =>
  getRequiredEnv('AZURE_AI_PROJECT_ENDPOINT', ['FOUNDRY_PROJECT_ENDPOINT'])

const getClient = () => {
  if (!cachedClient) {
    cachedClient = new AIProjectClient(
      getProjectEndpoint(),
      new DefaultAzureCredential(),
    )
  }

  return cachedClient
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const createThreadWithClient = async (client) => {
  if (typeof client.agents.createThread === 'function') {
    return client.agents.createThread()
  }

  return client.agents.threads.create()
}

const createMessageWithClient = async (client, threadId, message) => {
  if (typeof client.agents.createMessage === 'function') {
    return client.agents.createMessage(threadId, {
      role: 'user',
      content: message,
    })
  }

  return client.agents.messages.create(threadId, 'user', message)
}

const createRunWithClient = async (client, threadId, agentId) => {
  if (typeof client.agents.createRun === 'function') {
    return client.agents.createRun(threadId, agentId)
  }

  return client.agents.runs.create(threadId, agentId)
}

const getRunWithClient = async (client, threadId, runId) => {
  if (typeof client.agents.getRun === 'function') {
    return client.agents.getRun(threadId, runId)
  }

  return client.agents.runs.get(threadId, runId)
}

const listMessagesWithClient = async (client, threadId, runId) => {
  if (typeof client.agents.listMessages === 'function') {
    const page = await client.agents.listMessages(threadId, {
      runId,
      order: 'desc',
      limit: 20,
    })

    return Array.isArray(page?.data) ? page.data : []
  }

  const messages = []
  for await (const item of client.agents.messages.list(threadId, {
    runId,
    order: 'desc',
    limit: 20,
  })) {
    messages.push(item)
    console.log('---msg -', messages)
  }

  return messages
}

const extractAssistantReply = (messages) => {
  console.log('--message -', messages)
  const assistantMessage = messages.find((message) => message.role === 'assistant')
  console.log('---assistant msg -', assistantMessage)

  if (!assistantMessage) {
    throw new AzureAgentServiceError(
      'The agent run completed, but no assistant reply was returned.',
      502,
    )
  }

  const reply = assistantMessage.content
    .filter((item) => item?.type === 'text' && typeof item?.text?.value === 'string')
    .map((item) => item.text.value.trim())
    .filter(Boolean)
    .join('\n\n')

  if (!reply) {
    throw new AzureAgentServiceError(
      'The assistant reply did not contain text content.',
      502,
    )
  }

  return reply
}

const waitForRunCompletion = async (threadId, runId) => {
  const client = getClient()

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const run = await getRunWithClient(client, threadId, runId)

    if (run.status === 'completed') {
      return run
    }

    if (run.status === 'failed') {
      throw new AzureAgentServiceError(
        'Azure agent run failed.',
        502,
        { threadId, runId, status: run.status, lastError: run.lastError ?? null },
      )
    }

    if (run.status === 'cancelled' || run.status === 'cancelling' || run.status === 'expired') {
      throw new AzureAgentServiceError(
        `Azure agent run ended with status \`${run.status}\`.`,
        502,
        { threadId, runId, status: run.status },
      )
    }

    if (run.status === 'requires_action') {
      throw new AzureAgentServiceError(
        'Azure agent run requires tool outputs that this backend is not configured to provide.',
        502,
        { threadId, runId, status: run.status },
      )
    }

    await delay(POLL_INTERVAL_MS)
  }

  throw new AzureAgentServiceError(
    'Azure agent run timed out while waiting for completion.',
    504,
    {
      threadId,
      runId,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxPollAttempts: MAX_POLL_ATTEMPTS,
    },
  )
}

export const createThread = async () => {
  try {
    const thread = await createThreadWithClient(getClient())
    return thread.id
  } catch (error) {
    throw toAzureServiceError(error, 'Failed to create a new Azure agent thread.')
  }
}

export const sendMessageToThread = async ({ message, threadId }) => {
  const client = getClient()
  const agentId = getAgentId()
  const activeThreadId = threadId || await createThread()

  try {
    console.log('---trying the msg')
    await createMessageWithClient(client, activeThreadId, message)
    // console.log('----id -', client, activeThreadId, message)
    const run = await createRunWithClient(client, activeThreadId, agentId)
    const completedRun = await waitForRunCompletion(activeThreadId, run.id)
    const messages = await listMessagesWithClient(client, activeThreadId, completedRun.id)
    const reply = extractAssistantReply(messages)
    console.log('---reply -', reply)
    console.log('---threadId -', threadId)
    return {
      reply,
      threadId: activeThreadId,
    }
  } catch (error) {
    // console.log('---error- ', error)
    throw toAzureServiceError(error, 'Azure agent request failed.', {
      threadId: activeThreadId,
    })
  }
}
