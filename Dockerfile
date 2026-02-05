FROM mcr.microsoft.com/playwright:v1.58.1-jammy

WORKDIR /app

# Copiar package files
COPY package.json package-lock.json* ./

# Instalar dependências
RUN npm install

# Instalar navegadores Playwright
RUN npx playwright install chromium --with-deps

# Copiar código da aplicação
COPY . .

# Variáveis de ambiente
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Expor porta
EXPOSE 8080

# Iniciar aplicação
CMD ["npm", "start"]
