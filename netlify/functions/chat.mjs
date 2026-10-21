// Серверная часть чата «Дала Гид».
// Принимает историю диалога и (по желанию) одно фото, передаёт их Claude и возвращает текст ответа.
// Ключ API хранится только в переменных окружения Netlify и никогда не попадает на страницу сайта.

const SYSTEM =
  'You are "Дала", a friendly AI guide to tourism and landmarks in Kazakhstan on the website "Дала Гид". ' +
  'Always answer in Kazakh (қазақ тілі, Cyrillic script) unless the tourist writes in another language; then answer in theirs. ' +
  'Topics: landmarks, routes, seasons, transport, food, culture, safety in mountains and steppe, trip preparation. If a question is about something else, politely steer back to travel in Kazakhstan. ' +
  'Be concise: up to 160 words unless asked for more. For itineraries give a day-by-day breakdown. ' +
  'Never invent prices, timetables, visa rules or opening hours: say they change and point to official sources (МИД РК, carriers, park administrations). If unsure, say so plainly. ' +
  'If key details are missing (dates, budget, departure city) ask at most one clarifying question. ' +
  'Formatting: simple hyphen lists and **bold** for place names. No emoji, no tables.';

const PHOTO_RULES =
  'The tourist attached a photo with the latest message. Identify the place only from what is actually visible (architecture, terrain, rock shapes, water, signs, inscriptions). ' +
  'Start with "**Ең ықтимал жер:**" and the name with its region, then "**Сенімділік:**" with one of жоғары / орташа / төмен and one short sentence naming the visible clues. ' +
  'If confidence is not high, give up to two alternatives and ask for one more detail (where it was taken, another angle, a sign). ' +
  'If the photo shows no recognizable place, or the place appears to be outside Kazakhstan, say so plainly and do not guess; describe what you see and offer help planning a trip. ' +
  'Never name people in photos; talk only about the place. When the place is identified, add three short sections with bold headings: "**Қайда орналасқан**", "**Тарихы мен қызық деректер**", "**Қалай жетуге және қашан барған дұрыс**". ' +
  'Do not invent facts: if you are not sure of a detail, leave it out. Keep the whole answer under 220 words.';

const MAX_MESSAGES = 12;
const MAX_CHARS = 2000;
const MAX_IMAGE_B64 = 4_500_000; // ~3.4 МБ картинки, в пределах лимита запроса Netlify (6 МБ)
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Простое ограничение частоты: не более 20 запросов за 10 минут с одного адреса.
// Работает «по возможности» (память функции сбрасывается), но отсекает самый грубый перебор.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 20;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (limited(ip)) return json({ error: 'rate_limited' }, 429);

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: 'bad_json' }, 400);
  }

  // История диалога: только роли user/assistant, непустой текст, не длиннее лимита.
  let messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
    .slice(-MAX_MESSAGES);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return json({ error: 'bad_messages' }, 400);

  // Фото (необязательно): уже уменьшенный JPEG в base64.
  let image = null;
  if (body.image) {
    const t = body.image.media_type;
    const d = body.image.data;
    if (!IMAGE_TYPES.includes(t) || typeof d !== 'string' || d.length > MAX_IMAGE_B64 || !B64.test(d)) {
      return json({ error: 'bad_image' }, 400);
    }
    image = { media_type: t, data: d };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: 'no_key' }, 500);
  const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

  const last = messages[messages.length - 1];
  if (image) {
    last.content = [
      { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } },
      { type: 'text', text: last.content },
    ];
  }

  let res;
  try {
    res = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        system: image ? SYSTEM + '\n\n' + PHOTO_RULES : SYSTEM,
        messages,
      }),
      signal: AbortSignal.timeout(55000),
    });
  } catch (e) {
    console.error('Claude request failed:', e && e.message);
    return json({ error: 'network' }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('Claude API error', res.status, detail.slice(0, 500));
    return json({ error: res.status === 429 ? 'rate_limited' : 'upstream', status: res.status }, res.status === 429 ? 429 : 502);
  }

  const data = await res.json().catch(() => null);
  const text = data && Array.isArray(data.content) ? data.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '';
  if (!text.trim()) return json({ error: 'empty' }, 502);
  return json({ text });
};
