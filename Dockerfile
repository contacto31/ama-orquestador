FROM node:18-alpine

WORKDIR /app

# Solo necesitamos simple-health.js y package.json para esta prueba
COPY package*.json ./
COPY simple-health.js ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "simple-health.js"]
