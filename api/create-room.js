// 교사가 자신의 Gemini API 키를 입력하면, 그 키를 서버(Upstash Redis)에 저장하고
// 학생에게 공유할 짧은 "방 코드"를 발급한다. 학생 쪽에는 이 코드만 전달되고,
// 실제 API 키는 절대 클라이언트로 노출되지 않는다.

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외
const TTL_SECONDS = 60 * 60 * 48; // 방 유효기간: 48시간

// chat.js와 동일한 후보 목록 — 모델 하나가 종료돼도 키 검증 자체가 막히지 않게 한다.
const MODEL_CANDIDATES = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-2.5-flash'];

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// 후보가 전부 404(종료됨)일 때 최후의 수단: 이 키로 실제 쓸 수 있는 모델을 직접 조회한다.
async function discoverAnyModel(apiKey) {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const usable = (data.models || []).find((m) => {
      const name = m.name || '';
      const methods = m.supportedGenerationMethods || [];
      return (
        methods.includes('generateContent') &&
        name.includes('gemini') &&
        !/vision|embedding|live|image|audio|tts|robotics|preview/.test(name)
      );
    });
    return usable ? usable.name.replace(/^models\//, '') : null;
  } catch (e) {
    return null;
  }
}

async function testKeyAgainstGemini(apiKey) {
  let sawOnly404 = true;
  let lastStatus = null;
  for (const model of MODEL_CANDIDATES) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
        }
      );
      if (res.status === 404) {
        // 이 모델이 종료됨 — 다음 후보로 계속 시도
        lastStatus = 404;
        continue;
      }
      sawOnly404 = false;
      if (res.ok) return { ok: true };
      const body = await res.text();
      console.error(`키 검증 실패(${model}):`, res.status, body.slice(0, 300));
      return { ok: false, status: res.status };
    } catch (e) {
      console.error(`키 검증 중 예외(${model}):`, e);
      lastStatus = 500;
      sawOnly404 = false;
    }
  }
  // 후보가 전부 404였다면, 실제로 쓸 수 있는 모델이 있는지 마지막으로 직접 조회해본다.
  if (sawOnly404) {
    const discovered = await discoverAnyModel(apiKey);
    if (discovered) return { ok: true };
  }
  return { ok: false, status: lastStatus || 404 };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 허용됩니다.' });
    return;
  }

  const { apiKey } = req.body || {};
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
    res.status(400).json({ error: '올바른 Gemini API 키를 입력해 주세요.' });
    return;
  }

  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  if (!redisUrl || !redisToken) {
    res.status(500).json({ error: '서버 저장소 설정이 되어있지 않습니다. 관리자에게 문의하세요.' });
    return;
  }

  const roomCode = generateRoomCode();
  const trimmedKey = apiKey.trim();

  // 키가 실제로 Gemini에서 작동하는지 방을 만들기 전에 먼저 확인한다.
  // (여기서 안 걸러지면, 학생들이 쓰는 도중에야 조용히 실패해서 원인 찾기가 훨씬 어려워진다.)
  const testResult = await testKeyAgainstGemini(trimmedKey);
  if (!testResult.ok) {
    if (testResult.status === 400 || testResult.status === 403) {
      res.status(400).json({ error: '이 API 키가 유효하지 않은 것 같아요. Google AI Studio에서 키를 다시 확인해 주세요.' });
    } else if (testResult.status === 404) {
      res.status(400).json({ error: '사용 가능한 AI 모델을 찾지 못했어요. 관리자에게 문의해 주세요.' });
    } else {
      res.status(400).json({ error: `키 확인 중 문제가 발생했어요. (상태 코드 ${testResult.status})` });
    }
    return;
  }

  try {
    const setUrl = `${redisUrl}/set/room:${roomCode}/${encodeURIComponent(trimmedKey)}?EX=${TTL_SECONDS}`;
    const setRes = await fetch(setUrl, {
      headers: { Authorization: `Bearer ${redisToken}` },
    });
    if (!setRes.ok) {
      res.status(500).json({ error: '방을 만드는 데 실패했어요. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    res.status(200).json({ roomCode, expiresInHours: 48 });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했어요.' });
  }
};
