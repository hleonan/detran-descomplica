# ============================================================
# Despachante Virtual RJ - Dockerfile Corrigido
# ============================================================
# SOLUÇÃO: Usar a imagem oficial do Playwright que já inclui
# o Chromium e TODAS as dependências do Linux necessárias.
# Isso elimina o erro "Executable doesn't exist".
# ============================================================

# STAGE 1: Imagem oficial do Playwright (já tem Chromium + deps)
FROM mcr.microsoft.com/playwright:v1.58.2-noble

# Define diretório de trabalho
WORKDIR /app

# Copia arquivos de dependência primeiro (para cache do Docker)
COPY package*.json ./

# Instala dependências do projeto (sem precisar instalar browsers de novo)
# O --ignore-scripts evita que o postinstall do playwright tente baixar browsers
# pois eles já estão na imagem base
RUN npm ci

# Copia o resto do código da aplicação
COPY . .

# Variáveis de ambiente para produção
ENV NODE_ENV=production
ENV PORT=8080

# Expõe a porta que o Cloud Run vai usar
EXPOSE 8080

# Inicia o servidor
CMD ["npm", "start"]
