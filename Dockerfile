FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["npm", "start"]
