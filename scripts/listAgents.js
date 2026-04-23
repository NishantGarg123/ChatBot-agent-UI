import 'dotenv/config'
import { AIProjectClient } from '@azure/ai-projects'
import { DefaultAzureCredential } from '@azure/identity'

const projectEndpoint = process.env.AZURE_AI_PROJECT_ENDPOINT ?? process.env.FOUNDRY_PROJECT_ENDPOINT
const configuredAgentId = process.env.AZURE_AI_AGENT_ID ?? process.env.AZURE_AGENT_ID
const configuredAgentName = process.env.AZURE_AI_AGENT_NAME
const inputMessage = process.env.TEST_MESSAGE ?? 'How to start machine?'

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

const resolveAgent = async (client) => {
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
    return matched
  }

  if (configuredAgentName) {
    const matched = allAgents.find((agent) => agent.name === configuredAgentName)
    if (!matched) {
      throw new Error(`Configured AZURE_AI_AGENT_NAME not found in project: ${configuredAgentName}`)
    }
    return matched
  }

  return allAgents[0]
}

try {
  const client = new AIProjectClient(projectEndpoint, new DefaultAzureCredential())
  const openai = client.getOpenAIClient()
  const selectedAgent = await resolveAgent(client)

  // Responses API in Foundry expects an agent reference object.
  const agentRef = {
    type: 'agent_reference',
    name: selectedAgent.name,
  }
  console.log('\nUsing agent:', `${selectedAgent.name} (${selectedAgent.id})`)

  const conversation = await openai.conversations.create()
  console.log('Created conversation:', conversation.id)

  let response = await openai.responses.create({
    agent: agentRef,
    conversation: conversation.id,
    input: inputMessage,
  })

  for (let i = 0; i < 40 && response.status === 'queued'; i += 1) {
    await delay(1500)
    response = await openai.responses.retrieve(response.id)
  }

  if (response.status !== 'completed') {
    throw new Error(`Response ended with status: ${response.status}`)
  }
  console.log('---response -', response)
  const reply = (response.output ?? [])
    .filter((item) => item.type === 'message' && item.role === 'assistant')
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text)
    .join('\n')

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
