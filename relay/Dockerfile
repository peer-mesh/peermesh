FROM node:20-alpine
WORKDIR /app

# Install relay dependencies
COPY package.json ./
RUN npm install --production

# Copy relay entry point and shared lib
COPY relay.js ./
COPY lib/mandate-relay.mjs ./lib/mandate-relay.mjs

EXPOSE 8080
CMD ["node", "relay.js"]
