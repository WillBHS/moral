// 학생(또는 테스트 중인 교사)의 브라우저는 이 엔드포인트만 호출한다.
// 여기서 방 코드로 저장된 교사의 API 키를 찾아, 서버가 대신 Gemini를 호출한다.
// 실제 API 키는 이 서버 함수 밖으로 절대 나가지 않는다.
//
// 대응 전략:
//   - Flash-Lite 계열은 무료 티어 하루 한도가 훨씬 넉넉해서(약 500회 vs 일반 Flash 약 20회),
//     기본값도 Lite 계열을 우선 시도하도록 순서를 잡았다.
//   - 모델이 종료됐을 때(404)뿐 아니라, 그 모델의 하루/분당 사용량을 다 썼을 때(429)도
//     같은 방식으로 "다음 후보 모델로 자동 전환"한다 — 모델마다 한도가 따로 있어서,
//     하나가 막혀도 다른 모델로 계속 버틸 수 있다.
//   - 후보가 전부 실패하면, 이 키로 지금 실제 쓸 수 있는 모델을 직접 조회해서 마지막으로 시도한다.
const MODEL_CANDIDATES = {
  default: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
  quick: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
};

async function callGemini(apiKey, model, prompt) {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
}

function extractText(data) {
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  return (parts || []).map((p) => p.text || '').join('').trim();
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
  let sawOnlySkippable = true; // 404(모델 없음) 또는 429(한도 초과)만 겪었는지
  let anyRateLimited = false;
  let lastError = null;

  for (const model of candidates) {
    try {
      const geminiRes = await callGemini(apiKey, model, prompt);

      if (geminiRes.status === 404) {
        console.error(`모델 ${model}: 404(모델 없음), 다음 후보로 시도`);
        lastError = { status: 404, detail: `model not found: ${model}` };
        continue;
      }

      if (geminiRes.status === 429) {
        console.error(`모델 ${model}: 429(사용량 한도 초과), 다음 후보로 시도`);
        lastError = { status: 429, detail: `rate/quota limited: ${model}` };
        anyRateLimited = true;
        continue;
      }

      sawOnlySkippable = false;

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        console.error(`모델 ${model} 호출 실패:`, geminiRes.status, errText.slice(0, 300));
        res.status(502).json({ error: 'AI 응답에 실패했어요.', detail: errText.slice(0, 300) });
        return;
      }

      const data = await geminiRes.json();
      const text = extractText(data);
      res.status(200).json({ text, modelUsed: model });
      return;
    } catch (e) {
      console.error(`모델 ${model} 호출 중 예외:`, e);
      lastError = { status: 500, detail: String(e) };
      sawOnlySkippable = false;
    }
  }

  // 후보 목록이 전부 404/429였다면 마지막 수단으로 직접 조회해서 시도한다.
  if (sawOnlySkippable) {
    const discovered = await discoverModel(apiKey, isQuick);
    if (discovered) {
      try {
        const geminiRes = await callGemini(apiKey, discovered, prompt);
        if (geminiRes.ok) {
          const data = await geminiRes.json();
          const text = extractText(data);
          res.status(200).json({ text, modelUsed: discovered, viaDiscovery: true });
          return;
        }
        if (geminiRes.status === 429) anyRateLimited = true;
      } catch (e) {
        console.error('자동 발견 모델 호출 실패:', e);
      }
    }
  }

  if (anyRateLimited) {
    res.status(429).json({
      error: '지금 이 키로 쓸 수 있는 AI 사용량을 다 썼어요. 잠시 후 다시 시도하거나, 내일 다시 이용해 주세요. (선생님: Google AI Studio에서 키에 결제를 연결하면 이 한도가 크게 늘어납니다.)',
      detail: lastError ? JSON.stringify(lastError) : '',
    });
    return;
  }

  res.status(502).json({
    error: '사용 가능한 AI 모델을 찾지 못했어요. 관리자에게 문의해 주세요.',
    detail: lastError ? JSON.stringify(lastError) : '',
  });
};
