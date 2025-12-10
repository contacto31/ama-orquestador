FROM node:18-alpine

# Carpeta de trabajo dentro del contenedor
WORKDIR /app

# Instalar dependencias
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar el resto del código
COPY . .

# Variables básicas (el PORT real lo seguimos pasando por env en Easypanel)
ENV NODE_ENV=production
ENV PORT=3000

# Exponer puerto (informativo)
EXPOSE 3000

# Comando de arranque
CMD ["node", "index.js"]
