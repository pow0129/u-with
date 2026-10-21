FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV DELETION_DB_PATH=/data/deletion-queue.sqlite

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node index.js slash_commands.js config.yml help.txt ./
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "index.js"]
