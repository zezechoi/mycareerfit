import { lookup } from 'node:dns/promises';
import net from 'node:net';

export const config = {
  maxDuration: 30,
};

function isPrivateIp(ip) {
  // IPv4
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127) return true;          // this-network, private, loopback
    if (a === 169 && b === 254) return true;                     // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;            // private
    if (a === 192 && b === 168) return true;                     // private
    if (a === 100 && b >= 64 && b <= 127) return true;           // CGNAT
    if (a >= 224) return true;                                   // multicast / reserved
    return false;
  }
  // IPv6
  const low = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (low === '::1' || low === '::') return true;                // loopback / unspecified
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique local
  if (low.startsWith('fe80')) return true;                       // link-local
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7)); // IPv4-mapped
  return false;
}

// throws if the host is internal / loopback / encoded-IP
async function assertPublicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('내부 주소는 허용되지 않아요.');
  }
  // raw IP literal
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('내부 IP는 허용되지 않아요.');
    return;
  }
  // encoded IP (decimal like 2130706433, or hex like 0x7f000001)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    throw new Error('허용되지 않는 주소 형식이에요.');
  }
  // resolve DNS and check the actual target IP
  let address;
  try { ({ address } = await lookup(host)); }
  catch { throw new Error('도메인을 찾을 수 없어요.'); }
  if (isPrivateIp(address)) throw new Error('내부 네트워크로 연결되는 주소는 허용되지 않아요.');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  // 각자 키 모드: 본인 Anthropic 키 헤더가 있으면 형식만 확인하고 통과
  // (이 엔드포인트는 Anthropic을 호출하지 않고 공개 URL 텍스트만 가져옴 — SSRF 보호는 아래 assertPublicHost가 담당)
  // (레거시 폴백: 키가 없으면 기존 비번 게이트)
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

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: { message: 'url required' } });
  }

  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: { message: '올바른 URL 형식이 아니에요.' } }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: { message: 'http:// 또는 https:// URL만 지원해요.' } });
  }

  try {
    // follow redirects manually, re-validating the host at every hop
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let current = parsed;
    let upstream;
    let hops = 0;
    while (true) {
      await assertPublicHost(current.hostname);
      upstream = await fetch(current.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CareerFitBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
        signal: controller.signal,
        redirect: 'manual',
      });
      const loc = upstream.headers.get('location');
      if (upstream.status >= 300 && upstream.status < 400 && loc) {
        if (++hops > 3) { clearTimeout(timer); return res.status(502).json({ error: { message: '리다이렉트가 너무 많아요.' } }); }
        let next;
        try { next = new URL(loc, current); }
        catch { clearTimeout(timer); return res.status(502).json({ error: { message: '잘못된 리다이렉트 주소예요.' } }); }
        if (!['http:', 'https:'].includes(next.protocol)) { clearTimeout(timer); return res.status(400).json({ error: { message: '허용되지 않는 리다이렉트예요.' } }); }
        current = next;
        continue;
      }
      break;
    }
    clearTimeout(timer);

    if (!upstream.ok) {
      return res.status(502).json({ error: { message: `링크를 가져오지 못했어요 (HTTP ${upstream.status}).` } });
    }

    // size guard — read up to ~3MB then stop
    const reader = upstream.body.getReader();
    const chunks = [];
    let total = 0;
    const MAX = 3 * 1024 * 1024;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX) { reader.cancel(); break; }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { buf.set(c, pos); pos += c.length; }
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf);

    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) {
      return res.status(502).json({ error: { message: '링크에서 텍스트를 추출하지 못했어요. JS로 렌더링되는 페이지일 수 있어요.' } });
    }

    return res.status(200).json({ text: text.slice(0, 15000) });
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? '링크 응답이 너무 느려요 (15초 초과).'
      : (err.message || '링크 가져오기 실패');
    return res.status(502).json({ error: { message: msg } });
  }
}
