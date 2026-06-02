export const config = {
  maxDuration: 30,
};

// Vercel KV 통합(KV_REST_API_*) 또는 Upstash 직접(UPSTASH_REDIS_REST_*) 둘 다 지원
function kvCreds() {
  const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return { url, token };
}

async function redis(cmd) {
  const { url, token } = kvCreds();
  if (!url || !token) throw new Error('NO_KV');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error('KV_HTTP_' + r.status);
  const j = await r.json();
  return j.result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  // 각자 키 모드: 본인 Anthropic 키 헤더가 있으면 형식만 확인하고 통과
  // (레거시 폴백: 키가 없으면 기존 비번 게이트. 현재 CLOUD_SYNC=false라 이 엔드포인트는 미사용)
  const userKey = (req.headers['x-anthropic-key'] || '').trim();
  if (userKey) {
    if (!userKey.startsWith('sk-ant-')) {
      return res.status(401).json({ error: { message: 'API 키 형식이 올바르지 않아요.' } });
    }
  } else {
    const expected = (process.env.APP_PASSWORD || '').trim();
    const provided = (req.headers['x-app-password'] || '').trim();
    if (!expected) {
      return res.status(500).json({ error: { message: '서버 설정 오류: APP_PASSWORD 환경변수가 등록되지 않았어요.' } });
    }
    if (!provided || provided !== expected) {
      return res.status(401).json({ error: { message: '비밀번호가 올바르지 않아요.' } });
    }
  }

  const { action, data } = req.body || {};
  const KEY = 'careerfit:data';

  try {
    if (action === 'load') {
      const raw = await redis(['GET', KEY]);
      let parsed = null;
      if (raw) { try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = null; } }
      return res.status(200).json({ data: parsed });
    }
    if (action === 'save') {
      await redis(['SET', KEY, JSON.stringify(data || {})]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: { message: 'unknown action' } });
  } catch (e) {
    if (e.message === 'NO_KV') {
      return res.status(500).json({ error: { message: '서버 설정 오류: KV(Upstash) 환경변수가 등록되지 않았어요. Vercel에서 저장소를 연결하고 Redeploy 해주세요.' } });
    }
    return res.status(500).json({ error: { message: e.message || '동기화 오류' } });
  }
}
