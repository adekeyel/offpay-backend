FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p src/uploads

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "src/server.js"]
