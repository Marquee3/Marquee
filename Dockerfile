FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# No npm dependencies to install.
COPY package.json ./
COPY src ./src
COPY config ./config
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
