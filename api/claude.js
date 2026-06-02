export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  // 각자 키 모드: 사용자가 본인 Anthropic 키를 헤더로 보내면 그 키로 호출.
  // (레거시 폴백: 키가 없으면 기존 공유키+비번 게이트 — 전환 기간 호환용)
  const userKey = (req.headers['x-anthropic-key'] || '').trim();
  let apiKey;
  if (userKey) {
    apiKey = userKey;
  } else {
    const expected = (process.env.APP_PASSWORD || '').trim();
    const provided = (req.headers['x-app-password'] || '').trim();
    if (!expected) {
      return res.status(500).json({ error: { message: '서버 설정 오류: Vercel에 APP_PASSWORD 환경변수가 등록되지 않았어요.' } });
    }
    if (!provided || provided !== expected) {
      return res.status(401).json({ error: { message: '비밀번호가 올바르지 않아요.' } });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: { message: '서버 설정 오류: Vercel에 ANTHROPIC_API_KEY 환경변수가 등록되지 않았어요.' } });
    }
    apiKey = process.env.ANTHROPIC_API_KEY;
  }

  const { messages, system, model, max_tokens } = req.body || {};
  if (!messages) {
    return res.status(400).json({ error: { message: 'messages required' } });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-5',
        max_tokens: max_tokens || 2048,
        system,
        messages,
      }),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message || 'Upstream error' } });
  }
}
