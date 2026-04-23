import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import chatRoutes from './routes/chat.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const distPath = path.join(__dirname, 'dist')

app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  })
})

app.use('/api', chatRoutes)

app.use(express.static(distPath))

app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'))
})

app.use((err, _req, res, _next) => {
  const statusCode = err.statusCode || 500
  const message = err.message || 'Internal server error.'

  console.error(
    JSON.stringify({
      level: 'error',
      timestamp: new Date().toISOString(),
      statusCode,
      message,
      details: err.details ?? null,
    }),
  )

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && err.details ? { details: err.details } : {}),
  })
})

app.listen(port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      timestamp: new Date().toISOString(),
      message: `Server listening on port ${port}`,
    }),
  )
})
