import {
  createThread,
  sendMessageToThread,
} from '../services/azureAgentService.js'

const logRequest = ({ threadId, message }) => {
  console.info(
    JSON.stringify({
      level: 'info',
      timestamp: new Date().toISOString(),
      threadId: threadId ?? null,
      message,
    }),
  )
}

export const postChatMessage = async (req, res, next) => {
  const { message, threadId } = req.body ?? {}

  if (typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({
      error: 'A non-empty `message` field is required.',
    })
  }

  logRequest({ threadId, message })

  try {
    const result = await sendMessageToThread({
      message: message.trim(),
      threadId: typeof threadId === 'string' && threadId.trim() ? threadId.trim() : undefined,
    })

    return res.status(200).json(result)
  } catch (error) {
    return next(error)
  }
}

export const createNewChat = async (_req, res, next) => {
  try {
    const threadId = await createThread()
    return res.status(201).json({ threadId })
  } catch (error) {
    return next(error)
  }
}
