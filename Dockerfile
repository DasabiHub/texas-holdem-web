FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY game/ ./game/
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=3448

EXPOSE 3448

CMD ["node", "server.js"]
