import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY || '';
const CERTIDAO_URL = 'https://www2.detran.rj.gov.br/portal/multas/certidao';
const RECAPTCHA_SITE_KEY = '6LfP47IUAAAAAIwbI5NOKHyvT9Pda17dl0nXl4xv';

const ROOT_DIR = path.join(__dirname, '..' );
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CERTIDOES_DIR = path.join(ROOT_DIR, 'certidoes-emitidas');
const HISTORICO_FILE = path.join(CERTIDOES_DIR, 'historico.json');

[CERTIDOES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

async function verificarSaldo() {
  if (!TWOCAPTCHA_API_KEY) return { success: false, error: 'API Key não configurada' };
  try {
    const res = await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=getbalance&json=1` );
    const data = await res.json();
    return data.status === 1 ? { success: true, balance: Number(data.request) } : { success: false, error: data.request };
  } catch (e) { return { success: false, error: e.message }; }
}

async function resolverRecaptcha(pageUrl, siteKey) {
  if (!TWOCAPTCHA_API_KEY) return { success: false, error: 'API Key não configurada' };
  try {
    const submit = await (await fetch(`https://2captcha.com/in.php?key=${TWOCAPTCHA_API_KEY}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl )}&json=1`)).json();
    if (submit.status !== 1) return { success: false, error: submit.request };
    const id = submit.request;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await (await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_API_KEY}&action=get&id=${id}&json=1` )).json();
      if (res.status === 1) return { success: true, token: res.request };
      if (res.request !== 'CAPCHA_NOT_READY') return { success: false, error: res.request };
    }
    return { success: false, error: 'Timeout' };
  } catch (e) { return { success: false, error: e.message }; }
}

async function executarAutomacao(cpf, cnh) {
  console.log(`[AUTO] CPF: ${cpf}, CNH: ${cnh}`);
  const saldo = await verificarSaldo();
  if (!saldo.success || saldo.balance < 0.01) throw new Error('Saldo 2Captcha insuficiente');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  try {
    await page.goto(CERTIDAO_URL, { waitUntil: 'networkidle' });
    await page.fill('#CertidaoCpf', cpf);
    await page.selectOption('#CertidaoTipo', '2');
    await page.waitForTimeout(500);
    await page.fill('#CertidaoCnh', cnh);

    const captcha = await resolverRecaptcha(CERTIDAO_URL, RECAPTCHA_SITE_KEY);
    if (!captcha.success) throw new Error('Falha CAPTCHA: ' + captcha.error);

    await page.evaluate(token => {
      let ta = document.querySelector('textarea[name="g-recaptcha-response"]');
      if (!ta) { ta = document.createElement('textarea'); ta.name = 'g-recaptcha-response'; ta.style.display = 'none'; document.body.appendChild(ta); }
      ta.value = token;
    }, captcha.token);

    await page.click('#btPesquisar');
    await page.waitForTimeout(8000);
    const screenshot1 = await page.screenshot({ fullPage: true, type: 'png' });

    let screenshot2 = null;
    try {
      const linkUrl = await page.evaluate(() => {
        for (const a of document.querySelectorAll('a')) if (a.textContent?.includes('Clique aqui')) return a.href;
        return null;
      });
      if (linkUrl) {
        await page.goto(linkUrl, { waitUntil: 'networkidle' });
        await page.waitForTimeout(3000);
        screenshot2 = await page.screenshot({ fullPage: true, type: 'png' });
      }
    } catch (e) { console.log('[AUTO] Página 2 não encontrada'); }

    const pdf = await PDFDocument.create();
    const img1 = await pdf.embedPng(screenshot1);
    pdf.addPage([img1.width, img1.height]).drawImage(img1, { x: 0, y: 0, width: img1.width, height: img1.height });
    if (screenshot2) {
      const img2 = await pdf.embedPng(screenshot2);
      pdf.addPage([img2.width, img2.height]).drawImage(img2, { x: 0, y: 0, width: img2.width, height: img2.height });
    }

    const pdfBytes = await pdf.save();
    const nomeArquivo = `certidao-${cpf}-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(CERTIDOES_DIR, nomeArquivo), pdfBytes);

    let historico = [];
    try { historico = JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf-8')); } catch {}
    historico.push({ id: Date.now(), data: new Date().toLocaleString('pt-BR'), cpf, cnh, arquivo: nomeArquivo, paginas: screenshot2 ? 2 : 1 });
    fs.writeFileSync(HISTORICO_FILE, JSON.stringify(historico, null, 2));

    return { nomeArquivo, paginas: screenshot2 ? 2 : 1 };
  } finally {
    await context.close();
    await browser.close();
  }
}

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/api/saldo', async (req, res) => res.json(await verificarSaldo()));
app.get('/api/status', (req, res) => res.json({ status: 'online', twocaptcha: TWOCAPTCHA_API_KEY ? 'ok' : 'não configurado' }));
app.get('/api/historico', (req, res) => {
  try { res.json({ certidoes: JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf-8')) }); }
  catch { res.json({ certidoes: [] }); }
});
app.get('/api/download/:arquivo', (req, res) => {
  const caminho = path.join(CERTIDOES_DIR, req.params.arquivo);
  if (!fs.existsSync(caminho)) return res.status(404).json({ error: 'Não encontrado' });
  res.download(caminho);
});
app.post('/api/emitir', async (req, res) => {
  const { cpf, cnh } = req.body || {};
  if (!cpf || !cnh) return res.json({ success: false, error: 'CPF e CNH obrigatórios' });
  if (!TWOCAPTCHA_API_KEY) return res.json({ success: false, error: 'API Key não configurada' });
  try {
    const resultado = await executarAutomacao(cpf.replace(/\D/g, ''), cnh.replace(/\D/g, ''));
    res.json({ success: true, arquivo: resultado.nomeArquivo, paginas: resultado.paginas });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
