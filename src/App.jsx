import { useMemo, useRef, useEffect, useState } from 'react'
import './App.css'

const quickPrompts = [
  { icon: '🚀', text: 'Summarize the machine startup steps.' },
  { icon: '🔴', text: 'What are the machine shutdown steps?' },
  { icon: '⚡', text: 'What are the electrical safety precautions?' },
  { icon: '🔒', text: 'How to perform lockout/tagout on the machine?' },
  { icon: '💡', text: 'What does the red light on the light column indicate?' },
]

const initialMessages = [
  {
    id: 1,
    role: 'assistant',
    content:
      "Hi! I'm your RAG Assistant. Ask me anything from your Azure AI Foundry knowledge source.",
    time: '10:10 AM',
  },
]

const getPageFromId = (id) => {
  try {
    const parts = id.split('_pages_')
    if (parts.length < 2) return null
    return parseInt(parts[1], 10)
  } catch {
    return null
  }
}

const SOURCE_SCORE_THRESHOLD = 0.025

const getDocumentScore = (doc) => {
  const rawScore = doc?.score ?? doc?.['@search.score'] ?? doc?.searchScore ?? doc?.rerankerScore
  const score = Number(rawScore)
  return Number.isFinite(score) ? score : 0
}

const extractSources = (data) => {
  if (!Array.isArray(data?.output)) return []
  const searchOutput = data.output.find(
    (item) => item?.type === 'azure_ai_search_call_output',
  )
  if (!searchOutput?.output) return []

  let parsed
  try {
    parsed = typeof searchOutput.output === 'string'
      ? JSON.parse(searchOutput.output)
      : searchOutput.output
  } catch {
    return []
  }

  if (!Array.isArray(parsed?.documents)) return []

  const seen = new Set()
  const docs = parsed.documents
    .filter((doc) => getDocumentScore(doc) > SOURCE_SCORE_THRESHOLD)
    .filter((doc) => !isLikelyIndexContent(doc?.content || '', doc?.title || ''))
    .map((doc) => {
      const title = doc.title || 'Document'
      const page = getPageFromId(doc.id)
      const key = `${title}_${page}`
      if (seen.has(key)) return null
      seen.add(key)
      return { title, page, content: doc.content || '', score: getDocumentScore(doc) }
    })
    .filter(Boolean)

  docs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.page === null) return 1
    if (b.page === null) return -1
    return a.page - b.page
  })

  return docs.map((doc, idx) => ({ ...doc, num: idx + 1 }))
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const getSearchTerms = (query) => {
  if (!query || typeof query !== 'string') return []
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
    'be', 'by', 'as', 'at', 'it', 'that', 'this', 'from', 'what', 'how', 'when', 'where', 'which',
  ])
  const words = query
    .toLowerCase()
    .match(/[a-z0-9]+/g) || []
  const unique = [...new Set(words)]
  return unique.filter((word) => word.length > 2 && !stopWords.has(word))
}

const splitIntoParagraphs = (text) => {
  if (!text || typeof text !== 'string') return []
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)

  return paragraphs.length ? paragraphs : [normalized.replace(/\s+/g, ' ').trim()]
}

const isIndexLikeLine = (line) => {
  const trimmed = line.trim()
  if (!trimmed) return false

  // Typical TOC line pattern, e.g. "Machine Shutdown ......... 3.5"
  const dottedPagePattern = /(\.{3,}|\. ?\. ?\.)(\s+|$)\d+(\.\d+)?($|\s)/i
  const sectionPattern = /^(section|chapter|appendix)\s+\w+/i
  return dottedPagePattern.test(trimmed) || sectionPattern.test(trimmed)
}

const isLikelyIndexContent = (text, title = '') => {
  if (!text || typeof text !== 'string') return false
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (!lines.length) return false

  const indexLikeCount = lines.filter(isIndexLikeLine).length
  const indexLikeRatio = indexLikeCount / lines.length
  const hasIndexTitle = /\b(index|table of contents|contents)\b/i.test(title)

  return indexLikeRatio >= 0.35 || (hasIndexTitle && indexLikeRatio >= 0.2)
}

const renderHighlightedText = (text, terms) => {
  if (!terms.length) return text
  const pattern = new RegExp(`(${terms.map(escapeRegex).join('|')})`, 'gi')
  const parts = text.split(pattern)

  return parts.map((part, idx) => {
    const isMatch = terms.some((term) => term.toLowerCase() === part.toLowerCase())
    return isMatch ? (
      <mark key={`${part}-${idx}`} className="pdf-highlight">{part}</mark>
    ) : (
      <span key={`${part}-${idx}`}>{part}</span>
    )
  })
}

const extractResponseText = (data) => {
  if (!data) return null
  if (typeof data === 'string') return data

  const directCandidates = [
    data.output_text, data.answer, data.response, data.message, data.result,
  ]
  const directMatch = directCandidates.find(
    (value) => typeof value === 'string' && value.trim().length > 0,
  )
  if (directMatch) return directMatch

  if (Array.isArray(data.output)) {
    const messageItems = data.output.filter(
      (item) => item?.type === 'message' && item?.role === 'assistant',
    )
    const contentTexts = messageItems
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .map((contentItem) => {
        if (contentItem?.type === 'output_text' && typeof contentItem?.text === 'string')
          return contentItem.text
        if (typeof contentItem?.text === 'string') return contentItem.text
        if (typeof contentItem?.output_text === 'string') return contentItem.output_text
        if (typeof contentItem?.content === 'string') return contentItem.content
        return null
      })
      .filter(Boolean)
    if (contentTexts.length) return contentTexts.join('\n').trim()
  }

  if (data.error?.message) return `Agent error: ${data.error.message}`
  return null
}

const normalizeAssistantText = (text) => {
  if (!text || typeof text !== 'string') return text
  return text
    .replace(/\r\n/g, '\n')
    .replace(/(\S)\s+(\d+\.)\s+/g, '$1\n$2 ')
    .replace(/(\S)\s+([*-])\s+/g, '$1\n$2 ')
    .replace(/【[^】]*】/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const extractUsage = (data) => {
  if (!data?.usage) return null
  const { input_tokens, output_tokens, total_tokens } = data.usage
  if (
    typeof input_tokens !== 'number' ||
    typeof output_tokens !== 'number' ||
    typeof total_tokens !== 'number'
  ) return null
  return { input_tokens, output_tokens, total_tokens }
}

// Inline Sources Panel — renders right next to the message bubble
function InlineSourcesPanel({ sources, onClose, onOpenPdf }) {
  return (
    <div className="inline-sources-panel">
      <div className="isp-header">
        <span>📚 Sources ({sources.length})</span>
        <button className="isp-close" onClick={onClose}>✕</button>
      </div>
      <div className="isp-list">
        {sources.map((src) => (
          <button
            key={src.num}
            className="isp-item"
            onClick={() => onOpenPdf(src)}
          >
            <span className="isp-num">{src.num}</span>
            <div className="isp-info">
              <div className="isp-top">
                <span className="isp-title">{src.title}</span>
                {src.page !== null && (
                  <span className="isp-page">p.{src.page + 1}</span>
                )}
              </div>
              <span className="isp-preview">
                {src.content.replace(/\s+/g, ' ').trim().slice(0, 75)}…
              </span>
            </div>
            <span className="isp-arrow">›</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function App() {
  const [messages, setMessages] = useState(initialMessages)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [activePdf, setActivePdf] = useState(null)
  // Which message's sources panel is open
  const [openSourcesMsgId, setOpenSourcesMsgId] = useState(null)

  const messagesEndRef = useRef(null)

  const endpoint = import.meta.env.VITE_RAG_API_URL
  const apiKey = import.meta.env.VITE_AZURE_API_KEY
  const hasEndpoint = useMemo(() => Boolean(endpoint), [endpoint])
  const hasApiKey = useMemo(() => Boolean(apiKey), [apiKey])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const addUserMessage = (content) => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now(),
        role: 'user',
        content,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ])
  }

  const addAssistantMessage = (content, usage = null, sources = [], question = '') => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now() + 1,
        role: 'assistant',
        content,
        usage,
        sources,
        question,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      },
    ])
  }

  const getAgentReply = async (question) => {
    if (!hasEndpoint) return { content: 'UI is ready. Add your endpoint in `.env` as `VITE_RAG_API_URL`.', usage: null, sources: [] }
    if (!hasApiKey) return { content: 'Endpoint is set, but API key is missing. Add `VITE_AZURE_API_KEY` in `.env`.', usage: null, sources: [] }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({ input: question }),
      })

      if (!response.ok) return { content: 'I could not connect to your agent right now.', usage: null, sources: [] }

      const data = await response.json()
      const responseText = extractResponseText(data)
      const usage = extractUsage(data)
      const sources = extractSources(data)

      if (!responseText) console.warn('No answer text found:', data)

      return {
        content: normalizeAssistantText(responseText) || 'Response received, but no answer text was found.',
        usage,
        sources,
      }
    } catch (error) {
      return { content: `Connection error: ${error.message}`, usage: null, sources: [] }
    }
  }

  const handleSend = async (message) => {
    const trimmed = message.trim()
    if (!trimmed || isLoading) return

    setInput('')
    setOpenSourcesMsgId(null)
    addUserMessage(trimmed)
    setIsLoading(true)
    const reply = await getAgentReply(trimmed)
    addAssistantMessage(reply.content, reply.usage, reply.sources, trimmed)
    setIsLoading(false)
  }

  const toggleSources = (msgId) => {
    setOpenSourcesMsgId((prev) => (prev === msgId ? null : msgId))
  }

  return (
    <div className="app-shell">
      <aside className="left-panel">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <h1>Equipment Manual Assistant</h1>
            <p>Smart answers from your enterprise knowledge</p>
          </div>
        </div>
        <div className="status-card prompts-card">
          <h2>💬 Quick Prompts</h2>
          <div className="prompt-list">
            {quickPrompts.map((prompt) => (
              <button key={prompt.text} onClick={() => handleSend(prompt.text)} className="prompt-chip">
                <span className="prompt-icon">{prompt.icon}</span>
                <span className="prompt-text">{prompt.text}</span>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="chat-panel">
        <section className="messages">
          {messages.map((message) => (
            <div key={message.id} className={`message-row ${message.role}`}>
              {/* Message bubble */}
              <article className={`message ${message.role}`}>
                <div className="avatar">{message.role === 'assistant' ? 'AI' : 'You'}</div>
                <div className="bubble-wrap">
                  <p className="bubble">{message.content}</p>
                  <span className="time">{message.time}</span>
                  {message.role === 'assistant' && message.usage && (
                    <span className="token-usage">
                      input: {message.usage.input_tokens} | output: {message.usage.output_tokens} | total: {message.usage.total_tokens}
                    </span>
                  )}
                  {message.role === 'assistant' && message.sources?.length > 0 && (
                    <button
                      className={`sources-link ${openSourcesMsgId === message.id ? 'active' : ''}`}
                      onClick={() => toggleSources(message.id)}
                    >
                      📚 Sources ({message.sources.length})
                      {openSourcesMsgId === message.id ? ' ▲' : ' ▼'}
                    </button>
                  )}
                </div>
              </article>

              {/* Inline sources panel — right of bubble, same row */}
              {message.role === 'assistant' &&
                openSourcesMsgId === message.id &&
                message.sources?.length > 0 && (
                  <InlineSourcesPanel
                    sources={message.sources}
                    onClose={() => setOpenSourcesMsgId(null)}
                    onOpenPdf={(src) => setActivePdf({ ...src, query: message.question })}
                  />
                )}
            </div>
          ))}
          {isLoading && (
            <div className="message-row assistant">
              <article className="message assistant">
                <div className="avatar">AI</div>
                <div className="bubble-wrap">
                  <p className="bubble typing">
                    <span></span><span></span><span></span>
                  </p>
                </div>
              </article>
            </div>
          )}
          <div ref={messagesEndRef} />
        </section>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            handleSend(input)
          }}
        >
          <input
            type="text"
            placeholder="Ask about your documents, reports, FAQs..."
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <button type="submit" disabled={isLoading || !input.trim()}>
            Send
          </button>
        </form>
      </main>

      {/* PDF Modal */}
      {activePdf && (
        <div className="pdf-modal-overlay" onClick={() => setActivePdf(null)}>
          <div className="pdf-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pdf-modal-header">
              <div className="pdf-modal-title">
                <span>📄</span>
                <span>{activePdf.title}</span>
                {activePdf.page !== null && (
                  <span className="pdf-page-badge">Page {activePdf.page + 1}</span>
                )}
              </div>
              <button className="pdf-close-btn" onClick={() => setActivePdf(null)}>✕</button>
            </div>
            <div className="pdf-modal-body">
              <div className="pdf-content-viewer">
                <div className="pdf-doc-meta">
                  <span className="pdf-doc-icon">📋</span>
                  <div>
                    <p className="pdf-doc-name">{activePdf.title}</p>
                    {activePdf.page !== null && (
                      <p className="pdf-doc-page">Extracted from Page {activePdf.page + 1}</p>
                    )}
                  </div>
                </div>
                <div className="pdf-divider" />
                <div className="pdf-text-body">
                  {splitIntoParagraphs(activePdf.content).map((paragraph, idx) => (
                    <p key={idx} className="pdf-line">
                      {renderHighlightedText(paragraph, getSearchTerms(activePdf.query))}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
