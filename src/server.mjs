import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import DetranAutomation from './detranAutomation.js';
import PontuacaoAutomation from './pontuacaoAutomation.mjs';
import OCRExtractor from './ocrExtractor.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de upload
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const extensoesPermitidas = ['.jpg', '.jpeg', '.png', '.pdf', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (extensoesPermitidas.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido'));
    }
  }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Instâncias
const detranAutomation = new DetranAutomation(process.env.TWOCAPTCHA_API_KEY);
const pontuacaoAutomation = new PontuacaoAutomation(process.env.TWOCAPTCHA_API_KEY);
const ocrExtractor = new OCRExtractor(process.env.GOOGLE_VISION_API_KEY);

// ============ ROTAS ============

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    twocaptcha: process.env.TWOCAPTCHA_API_KEY ? 'ok' : 'not_configured',
    googleVision: process.env.GOOGLE_VISION_API_KEY ? 'ok' : 'not_configured'
  });
});

app.get('/api/saldo', async (req, res) => {
  try {
    const saldo = await detranAutomation.obterSaldo2Captcha();
    res.json({ saldo: saldo });
  } catch (error) {
    res.status(500).json({ erro: error.message });
  }
});

// Emitir Certidão Nada Consta
app.post('/api/certidao', async (req, res) => {
  try {
    const { cpf, cnh } = req.body;

    if (!cpf || !cnh) {
      return res.status(400).json({ erro: 'CPF e CNH são obrigatórios' });
    }

    console.log(`Emitindo certidão para CPF: ${cpf}, CNH: ${cnh}`);

    const resultado = await detranAutomation.emitirCertidao(cpf, cnh);

    if (resultado.sucesso) {
      res.json({
        sucesso: true,
        mensagem: 'Certidão emitida com sucesso',
        arquivo: resultado.arquivo,
        dataEmissao: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        sucesso: false,
        erro: resultado.erro
      });
    }
  } catch (error) {
    console.error('Erro ao emitir certidão:', error);
    res.status(500).json({ erro: error.message });
  }
});

// Consultar Pontuação/Multas
app.post('/api/pontuacao', async (req, res) => {
  try {
    const { cpf, cnh, uf = 'RJ' } = req.body;

    if (!cpf || !cnh) {
      return res.status(400).json({ erro: 'CPF e CNH são obrigatórios' });
    }

    console.log(`Consultando pontuação para CPF: ${cpf}, CNH: ${cnh}, UF: ${uf}`);

    const resultado = await pontuacaoAutomation.consultarPontuacao(cpf, cnh, uf);

    if (resultado.sucesso) {
      res.json({
        sucesso: true,
        multas: resultado.multas,
        resumo: resultado.resumo,
        dataConsulta: resultado.dataConsulta
      });
    } else {
      res.status(400).json({
        sucesso: false,
        erro: resultado.erro
      });
    }
  } catch (error) {
    console.error('Erro ao consultar pontuação:', error);
    res.status(500).json({ erro: error.message });
  }
});

// Upload de CNH com OCR
app.post('/api/ocr/cnh', upload.single('cnh'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Arquivo não enviado' });
    }

    console.log(`Processando OCR para arquivo: ${req.file.filename}`);

    const resultado = await ocrExtractor.extrairDadosCNH(req.file.path);

    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Erro ao deletar arquivo:', err);
    });

    if (resultado.sucesso) {
      res.json({
        sucesso: true,
        dados: resultado.dados,
        confianca: resultado.confianca,
        textoCompleto: resultado.textoCompleto
      });
    } else {
      res.status(400).json({
        sucesso: false,
        erro: resultado.erro
      });
    }
  } catch (error) {
    console.error('Erro ao processar OCR:', error);
    res.status(500).json({ erro: error.message });
  }
});

// Extrair texto genérico
app.post('/api/ocr/texto', upload.single('imagem'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Arquivo não enviado' });
    }

    const resultado = await ocrExtractor.extrairTextoImagem(req.file.path);

    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Erro ao deletar arquivo:', err);
    });

    if (resultado.sucesso) {
      res.json({
        sucesso: true,
        texto: resultado.textoCompleto,
        anotacoes: resultado.anotacoes
      });
    } else {
      res.status(400).json({
        sucesso: false,
        erro: resultado.erro
      });
    }
  } catch (error) {
    console.error('Erro ao extrair texto:', error);
    res.status(500).json({ erro: error.message });
  }
});

// Fluxo completo (Upload CNH + Emitir Certidão)
app.post('/api/fluxo-completo', upload.single('cnh'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ erro: 'Arquivo CNH não enviado' });
    }

    console.log(`Iniciando fluxo completo com arquivo: ${req.file.filename}`);

    const ocrResultado = await ocrExtractor.extrairDadosCNH(req.file.path);

    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Erro ao deletar arquivo:', err);
    });

    if (!ocrResultado.sucesso) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Falha ao extrair dados da CNH',
        detalhes: ocrResultado.erro
      });
    }

    const { cpf, cnh } = ocrResultado.dados;

    if (!cpf || !cnh) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Não foi possível extrair CPF ou CNH da imagem',
        dados: ocrResultado.dados,
        confianca: ocrResultado.confianca
      });
    }

    const certidaoResultado = await detranAutomation.emitirCertidao(cpf, cnh);

    if (!certidaoResultado.sucesso) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Falha ao emitir certidão',
        detalhes: certidaoResultado.erro,
        dadosExtraidos: ocrResultado.dados
      });
    }

    res.json({
      sucesso: true,
      mensagem: 'Fluxo completo executado com sucesso',
      dadosExtraidos: ocrResultado.dados,
      confiancaOCR: ocrResultado.confianca,
      certidao: {
        arquivo: certidaoResultado.arquivo,
        dataEmissao: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Erro no fluxo completo:', error);
    res.status(500).json({ erro: error.message });
  }
});

// Tratamento de erros
app.use((err, req, res, next) => {
  console.error('Erro:', err);
  res.status(500).json({
    erro: err.message || 'Erro interno do servidor'
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor Detran Descomplica rodando na porta ${PORT}`);
  console.log(`📍 Status: ${process.env.TWOCAPTCHA_API_KEY ? '✅' : '❌'} 2Captcha`);
  console.log(`📍 Status: ${process.env.GOOGLE_VISION_API_KEY ? '✅' : '❌'} Google Vision`);
});

export default app;
