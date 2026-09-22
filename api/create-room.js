// 교사가 자신의 Gemini API 키를 입력하면, 그 키를 서버(Upstash Redis)에 저장하고
// 학생에게 공유할 짧은 "방 코드"를 발급한다. 학생 쪽에는 이 코드만 전달되고,
// 실제 API 키는 절대 클라이언트로 노출되지 않는다.

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외
const TTL_SECONDS = 60 * 60 * 48; // 방 유효기간: 48시간

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
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

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) {
    res.status(500).json({ error: '서버 저장소 설정이 되어있지 않습니다. 관리자에게 문의하세요.' });
    return;
  }

  const roomCode = generateRoomCode();
  const trimmedKey = apiKey.trim();

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
