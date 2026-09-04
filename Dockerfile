FROM node:24.20.0-bookworm-slim

WORKDIR /app
COPY chatgpt/package.json chatgpt/package-lock.json ./chatgpt/

WORKDIR /app/chatgpt
RUN npm ci --omit=dev

COPY chatgpt/ ./

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV HOST=0.0.0.0

VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
