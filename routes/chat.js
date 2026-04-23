import { Router } from 'express'
import { createNewChat, postChatMessage } from '../controllers/chatController.js'

const router = Router()

router.post('/chat', postChatMessage)
router.post('/new-chat', createNewChat)

export default router
