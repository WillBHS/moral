// 학생(또는 테스트 중인 교사)의 브라우저는 이 엔드포인트만 호출한다.
// 여기서 방 코드로 저장된 교사의 API 키를 찾아, 서버가 대신 Gemini를 호출한다.
// 실제 API 키는 이 서버 함수 밖으로 절대 나가지 않는다.

const MODELS = {
  default: 'gemini-2.5-flash',
  quick: 'gemini-2.5-flash-lite',
};

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

  const model = MODELS[tier] || MODELS.default;
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      res.status(502).json({ error: 'AI 응답에 실패했어요.', detail: errText.slice(0, 300) });
      return;
    }

    const data = await geminiRes.json();
    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const text = (parts || []).map((p) => p.text || '').join('').trim();
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: 'AI 호출 중 오류가 발생했어요.' });
  }
};
