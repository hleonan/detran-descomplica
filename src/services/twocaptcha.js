// src/services/twocaptcha.js
export async function get2CaptchaBalance(apiKey) {
  if (!apiKey) throw new Error("TWOCAPTCHA_API_KEY não informada");

  const url =
    `https://2captcha.com/res.php?key=${encodeURIComponent(apiKey)}` +
    `&action=getbalance&json=1`;

  const resp = await fetch(url);
  const data = await resp.json();

  if (!data || data.status !== 1) {
    throw new Error(`2Captcha erro: ${data?.request || "resposta inválida"}`);
  }

  // vem como string tipo "12.345"
  return data.request;
}
