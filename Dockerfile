FROM node:18-alpine

WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar el resto del código (index.js, etc.)
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Arrancar usando el script start (node index.js)
CMD ["npm", "start"]
