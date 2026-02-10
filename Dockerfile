# Usa uma imagem Node.js limpa e estável
FROM node:20-bookworm

# Define o diretório de trabalho
WORKDIR /app

# Copia os arquivos de dependência
COPY package*.json ./

# 1. Instala as bibliotecas do Node
RUN npm ci

# 2. O GRANDE SEGREDO: Instala o navegador e as dependências do Linux
# Isso garante que a versão do navegador seja EXATAMENTE a que o seu código precisa
RUN npx playwright install --with-deps chromium

# Copia o resto do código
COPY . .

# Variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=8080

# Expõe a porta
EXPOSE 8080

# Inicia
CMD ["npm", "start"]
