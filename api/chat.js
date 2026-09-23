// 학생(또는 테스트 중인 교사)의 브라우저는 이 엔드포인트만 호출한다.
// 여기서 방 코드로 저장된 교사의 API 키를 찾아, 서버가 대신 Gemini를 호출한다.
// 실제 API 키는 이 서버 함수 밖으로 절대 나가지 않는다.
//
// Gemini 모델은 몇 달 단위로 새 모델이 나오고 예전 모델은 종료(shut down)된다.
// 대응 전략은 2단계다:
//   1) 아래 정해둔 후보 목록을 순서대로 빠르게 시도한다(평소엔 이걸로 끝).
//   2) 후보가 전부 실패하면(전부 종료됐다면), Gemini의 "지금 쓸 수 있는 모델 목록"
//      조회 API를 직접 불러서 그 시점에 실제로 살아있는 모델을 자동으로 찾아 쓴다.
//      이러면 이 파일을 사람이 수동으로 고치지 않아도 당분간은 계속 작동한다.
const MODEL_CANDIDATES = {
  default: ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-2.5-flash'],
  quick: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
};

async function callGemini(apiKey, model, prompt) {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
}

// 후보 목록이 전부 실패했을 때만 호출되는 최후의 수단: 지금 이 키로 실제 쓸 수 있는
// 모델 목록을 직접 물어봐서, 쓸만한 걸 하나 골라 반환한다.
async function discoverModel(apiKey, preferLite) {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const usable = (data.models || []).filter((m) => {
      const name = m.name || '';
      const methods = m.supportedGenerationMethods || [];
      return (
        methods.includes('generateContent') &&
        name.includes('gemini') &&
        !/vision|embedding|live|image|audio|tts|robotics|preview/.test(name)
      );
    });
    const lite = usable.filter((m) => m.name.includes('lite'));
    const normal = usable.filter((m) => !m.name.includes('lite'));
    const picked = preferLite ? (lite[0] || normal[0]) : (normal[0] || lite[0]);
    if (!picked) return null;
    return picked.name.replace(/^models\//, '');
  } catch (e) {
    console.error('모델 자동 조회 실패:', e);
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 허용됩니다.' });
    return;
  }

  const { roomCode, prompt, tier } = req.body || {};
  if (!roomCode || !prompt) {
    res.status(400).json({ error: '잘못된 요청이에요.' });
    return;
  }

  const redisUrl = process.env.KV_REST_API_URL;
  const redisToken = process.env.KV_REST_API_TOKEN;
  if (!redisUrl || !redisToken) {
    res.status(500).json({ error: '서버 저장소 설정이 되어있지 않습니다.' });
    return;
  }

  let apiKey;
  try {
    const getUrl = `${redisUrl}/get/room:${String(roomCode).toUpperCase()}`;
    const getRes = await fetch(getUrl, {
      headers: { Authorization: `Bearer ${redisToken}` },
    });
    const getData = await getRes.json();
    apiKey = getData && getData.result;
  } catch (e) {
    res.status(500).json({ error: '방 정보를 확인하는 데 실패했어요.' });
    return;
  }

  if (!apiKey) {
    res.status(404).json({ error: '이 방은 만료되었거나 존재하지 않아요. 선생님께 새 링크를 요청해 주세요.' });
    return;
  }

  const isQuick = tier === 'quick';
  const candidates = MODEL_CANDIDATES[tier] || MODEL_CANDIDATES.default;
  let sawOnly404 = true;
  let lastError = null;

  for (const model of candidates) {
    try {
      const geminiRes = await callGemini(apiKey, model, prompt);

      if (geminiRes.status === 404) {
        console.error(`모델 ${model}: 404(모델 없음), 다음 후보로 시도`);
        lastError = { status: 404, detail: `model not found: ${model}` };
        continue;
      }

      sawOnly404 = false;

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        console.error(`모델 ${model} 호출 실패:`, geminiRes.status, errText.slice(0, 300));
        res.status(502).json({ error: 'AI 응답에 실패했어요.', detail: errText.slice(0, 300) });
        return;
      }

      const data = await geminiRes.json();
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = (parts || []).map((p) => p.text || '').join('').trim();
      res.status(200).json({ text, modelUsed: model });
      return;
    } catch (e) {
      console.error(`모델 ${model} 호출 중 예외:`, e);
      lastError = { status: 500, detail: String(e) };
      sawOnly404 = false;
    }
  }

  // 후보 목록이 전부 404였다면(즉 전부 종료됐다면) 마지막 수단으로 직접 조회해서 시도한다.
  if (sawOnly404) {
    const discovered = await discoverModel(apiKey, isQuick);
    if (discovered) {
      try {
        const geminiRes = await callGemini(apiKey, discovered, prompt);
        if (geminiRes.ok) {
          const data = await geminiRes.json();
          const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
          const text = (parts || []).map((p) => p.text || '').join('').trim();
          res.status(200).json({ text, modelUsed: discovered, viaDiscovery: true });
          return;
        }
      } catch (e) {
        console.error('자동 발견 모델 호출 실패:', e);
      }
    }
  }

  res.status(502).json({
    error: '사용 가능한 AI 모델을 찾지 못했어요. 관리자에게 문의해 주세요.',
    detail: lastError ? JSON.stringify(lastError) : '',
  });
};
