# Usa imagem Node.js estável
FROM node:20-bookworm

# Define diretório de trabalho
WORKDIR /app

# --- A CORREÇÃO MÁGICA ---
# Define onde o Playwright DEVE instalar e buscar os navegadores
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copia arquivos de dependência
COPY package*.json ./

# 1. Instala dependências do projeto
RUN npm ci

# 2. Cria a pasta e instala o navegador nela
RUN mkdir -p /ms-playwright && \
    npx playwright install --with-deps chromium

# Copia o resto do código
COPY . .

# Variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=8080

# Expõe a porta
EXPOSE 8080

# Inicia
CMD ["npm", "start"]
