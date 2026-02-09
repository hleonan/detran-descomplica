# Usa imagem oficial do Playwright (já vem com Node e navegadores)
FROM mcr.microsoft.com/playwright:v1.41.0-focal

# Define diretório
WORKDIR /app

# Copia arquivos de dependência
COPY package*.json ./

# Instala dependências do projeto
RUN npm install --production

# Copia o resto do código
COPY . .

# Expõe a porta 8080 (Cloud Run)
EXPOSE 8080

# Comando para iniciar (aponta para seu src/index.js ou onde inicia o servidor)
# Se o seu start script no package.json for "node src/index.js", use npm start
CMD ["npm", "start"]
