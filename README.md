# Дала Гид

Сайт-гид по Қазақстану с чатом, который узнаёт достопримечательности по фото.

- `public/index.html` — сам сайт (дизайн и чат).
- `netlify/functions/chat.mjs` — серверная часть: передаёт вопросы и фото в Claude. Ключ API лежит только в переменных окружения Netlify.
- `netlify.toml` — настройки Netlify (папка сайта и папка функций).

Переменные окружения (Netlify → Site configuration → Environment variables):

- `ANTHROPIC_API_KEY` — ключ Claude API. На некоторых тарифах Netlify он подставляется автоматически.
- `CLAUDE_MODEL` — необязательно, по умолчанию `claude-sonnet-5-5`.
