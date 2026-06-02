export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  // 각자 키 모드: 사용자가 보낸 본인 Anthropic 키로만 호출한다. (오너 키·비번 폴백 없음)
  const apiKey = (req.headers['x-anthropic-key'] || '').trim();
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    return res.status(401).json({ error: { message: 'API 키가 필요해요. 본인 Anthropic 키(sk-ant-...)를 입력해주세요.' } });
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
