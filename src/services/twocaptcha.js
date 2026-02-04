export async function get2CaptchaBalance() {
  const key = process.env.TWOCAPTCHA_API_KEY;
  if (!key) throw new Error('TWOCAPTCHA_API_KEY não configurada no Cloud Run');

  const url = `https://2captcha.com/res.php?key=${encodeURIComponent(key)}&action=getbalance&json=1`;
  const resp = await fetch(url);
  const data = await resp.json();

  if (!data || data.status !== 1) {
    throw new Error(`2Captcha erro: ${data?.request || 'resposta inválida'}`);
  }

  return data.request; // vem como string tipo "12.345"
}
