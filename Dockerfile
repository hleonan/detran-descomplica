# Alterado de v1.58.2 para v1.50.1 para bater com o seu package.json
FROM mcr.microsoft.com/playwright:v1.50.1-jammy

WORKDIR /app

# Copia arquivos de dependência
COPY package*.json ./

# Instala as dependências do projeto
RUN npm ci

# GARANTIA: Força a instalação do navegador correto caso a imagem base falhe
RUN npx playwright install chromium

# Copia o resto do código
COPY . .

# Define variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=8080

# Expõe a porta
EXPOSE 8080

# Inicia o servidor
CMD ["npm", "start"]
